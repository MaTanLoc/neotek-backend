/* global beforeAll, afterAll */
import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { CustomerController } from '../customer/customer.controller';
import { CustomerService } from '../customer/customer.service';
import { CustomerGoogleService } from '../customer/customer-google.service';
import { GoogleTokenVerifier } from '../customer/google-token-verifier';
import { CustomerPasswordRecoveryService } from '../customer/customer-password-recovery.service';
import { CustomerSessionService } from '../customer/customer-session.service';
import {
  CustomerGuard,
  CustomerMutationGuard,
} from '../customer/customer.guards';
import { BookingController } from './booking.controller';
import { AdminBookingController } from './admin-booking.controller';
import { BookingService } from './booking.service';
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleCalendarClient } from './google-calendar.client';
import {
  AdminGoogleCalendarController,
  GoogleCalendarCallbackController,
} from './google-calendar.controller';
import { bookingPolicy } from './booking-policy';
import { NotificationService } from '../notification/notification.service';
import { VerificationSecret } from '../notification/verification-secret';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { AuthService } from '../auth/auth.service';
import { AuthController } from '../auth/auth.controller';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { RolesGuard } from '../auth/roles.guard';
import { OriginGuard } from '../auth/origin.guard';
import { AdminRateLimitGuard } from '../auth/admin-rate-limit.guard';
import { LoginRateLimitGuard } from '../auth/login-rate-limit.guard';
import { hashPassword, verifyPassword } from '../auth/password.util';
import { CSRF_COOKIE } from '../auth/auth.constants';
import { configureHttpSecurity } from '../config/http-security';

const fetch = globalThis.fetch;
const postgres = process.env.BOOKING_TEST_DATABASE_URL
  ? describe
  : describe.skip;
postgres('Booking V1 HTTP with real disposable PostgreSQL', () => {
  let db: PrismaClient,
    app: INestApplication,
    base: string,
    service: BookingService;
  const secret = new VerificationSecret(randomBytes(32).toString('base64'));
  const notifications = new NotificationService();
  const values = new Map<string, string>();
  const counters = new Map<string, number>();
  const cache = {
    async set(key: string, value: string) {
      values.set(key, value);
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async del(key: string) {
      values.delete(key);
    },
    async consume(key: string) {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    async incrementWithExpiry(key: string) {
      const value = (counters.get(key) ?? 0) + 1;
      counters.set(key, value);
      return value;
    },
    async getOrCreateSessionToken(
      session: string,
      csrf: string,
      candidate: string,
    ) {
      if (!values.has(session)) return null;
      if (!values.has(csrf)) values.set(csrf, candidate);
      return values.get(csrf)!;
    },
  };
  const password = 'a secure HTTP test password';
  let cookieA: string,
    cookieB: string,
    csrfA: string,
    csrfB: string,
    emailA: string,
    accountA: string,
    adminCookie: string,
    editorCookie: string,
    adminCsrf: string;
  let heldId: string, bookingId: string;
  const originalOrigin = process.env.FRONTEND_URL;
  const originalGoogleFlag = process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED;
  const originalGoogleClient = process.env.GOOGLE_CUSTOMER_CLIENT_ID;
  const googleIdentities = new Map<
    string,
    Awaited<ReturnType<GoogleTokenVerifier['verify']>>
  >();
  const googleVerifier = {
    verify: jest.fn(async (credential: string) => {
      const identity = googleIdentities.get(credential);
      if (!identity)
        throw new UnauthorizedException('Google login could not be completed');
      return identity;
    }),
  };
  let googleService: CustomerGoogleService;
  let day = 65;
  function interval(offset = 0, dayOffset = ++day) {
    const start = new Date(Date.now() + dayOffset * 86400000);
    start.setUTCHours(2, offset, 0, 0);
    return {
      requestedStartAt: start.toISOString(),
      requestedEndAt: new Date(start.getTime() + 3600000).toISOString(),
      moduleKey: 'erp',
      idempotencyKey: randomUUID(),
    };
  }
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    cookie = '',
    csrf = '',
    origin = 'http://localhost:5173',
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' ? { Origin: origin } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      data: (await response.json()) as any,
      cookies: response.headers.getSetCookie(),
    };
  }
  beforeAll(async () => {
    const url = new URL(process.env.BOOKING_TEST_DATABASE_URL!);
    if (
      process.env.BOOKING_TEST_DISPOSABLE !== '1' ||
      url.hostname !== '127.0.0.1' ||
      url.pathname !== '/neotek_booking_disposable'
    )
      throw new Error('Disposable database required');
    process.env.FRONTEND_URL = 'http://localhost:5173';
    process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'true';
    process.env.GOOGLE_CUSTOMER_CLIENT_ID =
      'fixture.apps.googleusercontent.com';
    db = new PrismaClient({ datasources: { db: { url: url.href } } });
    await db.$connect();
    await db.page.upsert({
      where: { slug: 'solutions' },
      update: {},
      create: {
        slug: 'solutions',
        status: 'PUBLISHED',
        sections: {
          create: {
            key: 'modules',
            type: 'solutionModules',
            translations: {
              create: {
                locale: 'vi',
                content: { items: [{ key: 'erp', title: 'ERP consultation' }] },
              },
            },
          },
        },
      },
    });
    service = new BookingService(
      db as PrismaService,
      notifications,
      bookingPolicy({
        BOOKING_LEAD_MINUTES: '0',
        BOOKING_WORKING_DAYS: '0,1,2,3,4,5,6',
      }),
      'admin@example.test',
    );
    const customerService = new CustomerService(
      db as PrismaService,
      notifications,
      cache as unknown as CacheService,
      secret,
    );
    const module = await Test.createTestingModule({
      controllers: [
        CustomerController,
        BookingController,
        AdminBookingController,
        AuthController,
        AdminGoogleCalendarController,
        GoogleCalendarCallbackController,
      ],
      providers: [
        GoogleCalendarService,
        GoogleCalendarClient,
        CustomerGoogleService,
        { provide: GoogleTokenVerifier, useValue: googleVerifier },
        { provide: PrismaService, useValue: db },
        { provide: CacheService, useValue: cache },
        { provide: CustomerService, useValue: customerService },
        {
          provide: CustomerPasswordRecoveryService,
          useValue: new CustomerPasswordRecoveryService(
            db as PrismaService,
            cache as unknown as CacheService,
            notifications,
            secret,
          ),
        },
        { provide: BookingService, useValue: service },
        CustomerSessionService,
        CustomerGuard,
        CustomerMutationGuard,
        AuthService,
        SessionAuthGuard,
        CsrfGuard,
        RolesGuard,
        OriginGuard,
        AdminRateLimitGuard,
        LoginRateLimitGuard,
      ],
    }).compile();
    googleService = module.get(CustomerGoogleService);
    app = module.createNestApplication({ bodyParser: false, logger: false });
    configureHttpSecurity(app);
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api`;
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    if (db) await db.$disconnect();
    if (originalOrigin === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalOrigin;
    if (originalGoogleFlag === undefined)
      delete process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED;
    else process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = originalGoogleFlag;
    if (originalGoogleClient === undefined)
      delete process.env.GOOGLE_CUSTOMER_CLIENT_ID;
    else process.env.GOOGLE_CUSTOMER_CLIENT_ID = originalGoogleClient;
  });

  function googleFixture(
    email = `${randomUUID()}@gmail.com`,
    authoritativeEmail = true,
    subject = randomUUID(),
  ) {
    const credential = `fixture.${randomUUID().replaceAll('-', '')}.signature`;
    googleIdentities.set(credential, {
      subject,
      email,
      authoritativeEmail,
      name: 'Google fixture',
    });
    return { credential };
  }
  it('Google creates one verified passwordless customer, issues the normal session/CSRF, preserves CMS isolation and logs out', async () => {
    const body = googleFixture();
    const login = await request('/customer-auth/google', 'POST', body);
    expect(login.status).toBe(200);
    expect(login.data.customer.realm).toBe('customer');
    const cookie = login.cookies[0].split(';')[0];
    expect(cookie).toMatch(/^neotek_customer_session=[a-zA-Z0-9_-]{43}$/);
    expect(login.cookies[0]).toContain('HttpOnly');
    expect(login.cookies[0]).toContain('SameSite=Lax');
    expect(login.cookies[0]).toContain('Max-Age=28800');
    const account = await db.customerAccount.findUniqueOrThrow({
      where: { id: login.data.customer.customerId },
    });
    expect(account.passwordHash).toBeNull();
    expect(account.emailVerifiedAt).not.toBeNull();
    expect(
      await db.notificationDelivery.count({
        where: { customerId: account.id },
      }),
    ).toBe(0);
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookie)).data
        .customer.customerId,
    ).toBe(account.id);
    expect(
      (await request('/booking/mine', 'GET', undefined, cookie)).status,
    ).toBe(200);
    expect(
      (await request('/admin/bookings', 'GET', undefined, cookie)).status,
    ).toBe(401);
    expect(
      (await request('/customer-auth/me', 'GET', undefined, adminCookie))
        .status,
    ).toBe(401);
    const csrf = (
      await request('/customer-auth/csrf', 'GET', undefined, cookie)
    ).data.csrfToken;
    expect(
      (await request('/customer-auth/csrf', 'GET', undefined, cookie)).data
        .csrfToken,
    ).toBe(csrf);
    expect(
      (await request('/customer-auth/logout', 'POST', undefined, cookie, 'bad'))
        .status,
    ).toBe(403);
    expect(
      (await request('/customer-auth/logout', 'POST', undefined, cookie, csrf))
        .status,
    ).toBe(200);
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookie)).status,
    ).toBe(401);
  });
  it('Google links a verified email match without replacing password, name or existing verification timestamp', async () => {
    const email = `${randomUUID()}@gmail.com`,
      hash = await hashPassword(password),
      verified = new Date('2026-01-01T00:00:00Z');
    const existing = await db.customerAccount.create({
      data: {
        email,
        name: 'Keep name',
        passwordHash: hash,
        emailVerifiedAt: verified,
      },
    });
    const result = await googleService.authenticate(
      googleFixture(email),
      'google-link',
    );
    expect(result.customerId).toBe(existing.id);
    expect(
      await db.customerAccount.findUnique({ where: { id: existing.id } }),
    ).toMatchObject({
      passwordHash: hash,
      name: 'Keep name',
      emailVerifiedAt: verified,
    });
  });
  it('Google safely verifies a matched unverified account and revokes verification tokens and delivery secrets', async () => {
    const email = `${randomUUID()}@gmail.com`;
    const customers = app.get(CustomerService);
    await customers.register(
      {
        email,
        name: 'Unverified',
        phone: '0900000000',
        password,
        locale: 'vi',
      },
      'google-register',
    );
    const result = await googleService.authenticate(
      googleFixture(email),
      'google-unverified',
    );
    expect(result.emailVerifiedAt).not.toBeNull();
    expect(
      await db.customerEmailVerification.count({
        where: { customerId: result.customerId, revokedAt: null },
      }),
    ).toBe(0);
    expect(
      await db.notificationDelivery.findFirst({
        where: { customerId: result.customerId },
      }),
    ).toMatchObject({ status: 'REVOKED', encryptedSecret: null });
  });
  it('Google rejects third-party email auto-link, inactive accounts and alternate subjects for an already-linked email', async () => {
    const thirdEmail = `${randomUUID()}@example.test`;
    const third = await db.customerAccount.create({
      data: {
        email: thirdEmail,
        name: 'Existing',
        passwordHash: await hashPassword(password),
      },
    });
    await expect(
      googleService.authenticate(
        googleFixture(thirdEmail, false),
        'google-third',
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await db.customerOAuthIdentity.count({ where: { customerId: third.id } }),
    ).toBe(0);
    const email = `${randomUUID()}@gmail.com`,
      fixture = googleFixture(email);
    const linked = await googleService.authenticate(fixture, 'google-first');
    await expect(
      googleService.authenticate(googleFixture(email), 'google-other'),
    ).rejects.toMatchObject({ status: 401 });
    await db.customerAccount.update({
      where: { id: linked.customerId },
      data: { active: false },
    });
    await expect(
      googleService.authenticate(fixture, 'google-inactive'),
    ).rejects.toMatchObject({ status: 401 });
    const inactiveEmail = `${randomUUID()}@gmail.com`;
    await db.customerAccount.create({
      data: { email: inactiveEmail, name: 'Inactive', active: false },
    });
    await expect(
      googleService.authenticate(
        googleFixture(inactiveEmail),
        'google-inactive-new',
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('Google subject remains canonical when provider email changes; concurrent logins create one account and identity', async () => {
    const email = `${randomUUID()}@gmail.com`,
      subject = randomUUID(),
      body = googleFixture(email, true, subject);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        googleService.authenticate(body, `google-concurrent-${i}`),
      ),
    );
    expect(new Set(results.map((r) => r.customerId)).size).toBe(1);
    expect(await db.customerAccount.count({ where: { email } })).toBe(1);
    expect(
      await db.customerOAuthIdentity.count({
        where: { provider: 'GOOGLE', providerSubject: subject },
      }),
    ).toBe(1);
    const changed = await googleService.authenticate(
      googleFixture(`${randomUUID()}@gmail.com`, true, subject),
      'google-changed',
    );
    expect(changed.customerId).toBe(results[0].customerId);
    expect(changed.email).toBe(email);
  });
  it('concurrent linking to an existing password account creates one identity and rejects competing subjects', async () => {
    const email = `${randomUUID()}@gmail.com`,
      passwordHash = await hashPassword(password);
    const account = await db.customerAccount.create({
      data: { email, name: 'Existing concurrent', passwordHash },
    });
    const body = googleFixture(email);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        googleService.authenticate(body, `google-concurrent-link-${i}`),
      ),
    );
    expect(results.every((r) => r.customerId === account.id)).toBe(true);
    expect(
      await db.customerOAuthIdentity.count({
        where: { customerId: account.id },
      }),
    ).toBe(1);
    expect(
      (
        await db.customerAccount.findUniqueOrThrow({
          where: { id: account.id },
        })
      ).passwordHash,
    ).toBe(passwordHash);
    const secondEmail = `${randomUUID()}@gmail.com`;
    const competing = await Promise.allSettled([
      googleService.authenticate(
        googleFixture(secondEmail),
        'google-compete-a',
      ),
      googleService.authenticate(
        googleFixture(secondEmail),
        'google-compete-b',
      ),
    ]);
    expect(competing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(competing.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(
      await db.customerAccount.count({ where: { email: secondEmail } }),
    ).toBe(1);
  });
  it('concurrent registration and Google creation converge without overwriting credentials or creating duplicate identities', async () => {
    const email = `${randomUUID()}@gmail.com`,
      body = googleFixture(email);
    const [, google] = await Promise.all([
      app.get(CustomerService).register(
        {
          email,
          name: 'Password customer',
          phone: '0900000000',
          password,
          locale: 'en',
        },
        'google-register-race',
      ),
      googleService.authenticate(body, 'google-register-race'),
    ]);
    expect(await db.customerAccount.count({ where: { email } })).toBe(1);
    expect(
      await db.customerOAuthIdentity.count({
        where: { customerId: google.customerId },
      }),
    ).toBe(1);
    const account = await db.customerAccount.findUniqueOrThrow({
      where: { id: google.customerId },
    });
    if (account.passwordHash)
      expect(await verifyPassword(account.passwordHash, password)).toBe(true);
    expect(account.emailVerifiedAt).not.toBeNull();
  });
  it('Google-only customers cannot use password login until an email-proof reset sets a password and invalidates prior sessions', async () => {
    const body = googleFixture(),
      login = await request('/customer-auth/google', 'POST', body),
      cookie = login.cookies[0].split(';')[0];
    const { customerId, email } = login.data.customer;
    await app
      .get(CustomerPasswordRecoveryService)
      .forgot({ email, locale: 'en' }, 'google-only-forgot');
    expect(
      await db.notificationDelivery.count({
        where: { customerId, passwordResetId: { not: null } },
      }),
    ).toBe(1);
    await expect(
      app
        .get(CustomerService)
        .authenticate({ email, password }, 'google-password'),
    ).rejects.toMatchObject({ status: 401 });
    const raw = randomBytes(32).toString('base64url');
    await db.customerPasswordReset.create({
      data: {
        customerId,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    await app
      .get(CustomerPasswordRecoveryService)
      .reset(
        { token: raw, password, confirmPassword: password },
        'google-set-password',
      );
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookie)).status,
    ).toBe(401);
    expect(
      (
        await app
          .get(CustomerService)
          .authenticate({ email, password }, 'google-new-password')
      ).customerId,
    ).toBe(customerId);
    expect(
      (await googleService.authenticate(body, 'google-after-reset')).customerId,
    ).toBe(customerId);
    expect(
      await db.customerOAuthIdentity.count({ where: { customerId } }),
    ).toBe(1);
  });
  it('Google HTTP enforces exact origin, credential-only body, bounded parser and rejected verifier with no session', async () => {
    const body = googleFixture(),
      before = googleVerifier.verify.mock.calls.length;
    expect(
      (
        await request(
          '/customer-auth/google',
          'POST',
          body,
          '',
          '',
          'https://evil.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/customer-auth/google', 'POST', {
          ...body,
          customerId: 'forged',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/customer-auth/google', 'POST', {
          credential: 'x'.repeat(14000),
        })
      ).status,
    ).toBe(413);
    expect(googleVerifier.verify.mock.calls.length).toBe(before);
    const rejected = await request('/customer-auth/google', 'POST', {
      credential: 'fixture.invalidcredential.signature',
    });
    expect(rejected.status).toBe(401);
    expect(rejected.cookies).toEqual([]);
    process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'false';
    try {
      expect(
        (await request('/customer-auth/google', 'POST', body)).status,
      ).toBe(503);
    } finally {
      process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'true';
    }
  });

  it('allows anonymous sanitized availability/options and rejects hold/finalize without a customer', async () => {
    const times = interval();
    const result = await request(
      `/booking/availability?${new URLSearchParams({ from: times.requestedStartAt, to: times.requestedEndAt, duration: '60' })}`,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.data).sort()).toEqual([
      'busy',
      'periods',
      'serverNow',
      'timezone',
    ]);
    for (const period of result.data.periods)
      expect(Object.keys(period).sort()).toEqual(['available', 'end', 'start']);
    for (const period of result.data.busy)
      expect(Object.keys(period).sort()).toEqual(['available', 'end', 'start']);
    expect((await request('/booking/options')).data.modules).toEqual([
      { key: 'erp', vi: 'ERP consultation', en: 'ERP consultation' },
    ]);
    expect((await request('/booking/hold', 'POST', times)).status).toBe(401);
    expect((await request('/booking/finalize', 'POST', {})).status).toBe(401);
    expect((await request('/admin/bookings')).status).toBe(401);
  });
  it('registers safely, accepts duplicates and denies unverified login and legacy sessions', async () => {
    emailA = `${randomUUID()}@example.test`;
    const body = {
      email: emailA,
      name: 'Customer A',
      phone: '0900000000',
      password,
      locale: 'en',
    };
    expect(
      (await request('/customer-auth/register', 'POST', { ...body, phone: '' }))
        .status,
    ).toBe(400);
    expect(
      await request('/customer-auth/register', 'POST', body),
    ).toMatchObject({ status: 202, data: { accepted: true }, cookies: [] });
    expect(
      await request('/customer-auth/register', 'POST', body),
    ).toMatchObject({ status: 202, data: { accepted: true } });
    expect(await db.customerAccount.count({ where: { email: emailA } })).toBe(
      1,
    );
    expect(
      (await db.customerAccount.findUniqueOrThrow({ where: { email: emailA } }))
        .phone,
    ).toBe(body.phone);
    expect(
      (
        await request('/customer-auth/login', 'POST', {
          email: emailA,
          password: 'incorrect password value',
        })
      ).status,
    ).toBe(401);
    const login = await request('/customer-auth/login', 'POST', {
      email: emailA,
      password,
    });
    expect(login).toMatchObject({
      status: 403,
      data: { message: 'EMAIL_NOT_VERIFIED' },
      cookies: [],
    });
    const account = await db.customerAccount.findUniqueOrThrow({
      where: { email: emailA },
    });
    accountA = account.id;
    expect(account.emailVerifiedAt).toBeNull();
    const sessions = app.get(CustomerSessionService);
    await expect(
      sessions.issue(accountA, account.authVersion),
    ).rejects.toMatchObject({ status: 401 });
    const legacy = randomBytes(32).toString('base64url');
    values.set(
      sessions.key(legacy),
      JSON.stringify({
        realm: 'customer',
        customerId: accountA,
        authVersion: account.authVersion,
      }),
    );
    cookieA = `neotek_customer_session=${legacy}`;
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookieA)).status,
    ).toBe(401);
    expect(values.has(sessions.key(legacy))).toBe(false);
    expect(
      await request('/booking/hold', 'POST', interval(), cookieA, csrfA),
    ).toMatchObject({
      status: 401,
    });
    expect(
      (
        await request(
          '/booking/finalize',
          'POST',
          {
            holdId: 'missing',
            contactName: 'A',
            contactPhone: '0900000000',
            contactCompany: 'Company',
            locale: 'en',
            idempotencyKey: randomUUID(),
          },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(401);
  });
  it('verifies one-use tokens, rejects invalid/expired/reused links and applies resend cooldown', async () => {
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: accountA, template: 'CUSTOMER_EMAIL_VERIFICATION' },
    });
    const raw = secret.open(
      delivery.encryptedSecret!,
      delivery.verificationId!,
    );
    expect(
      (await request('/customer-auth/verify-email', 'POST', { token: 'bad' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request('/customer-auth/verify-email', 'POST', {
          token: randomBytes(32).toString('base64url'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/customer-auth/resend-verification',
          'POST',
          { email: emailA, locale: 'en' },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(202);
    expect(
      await db.customerEmailVerification.count({
        where: { customerId: accountA },
      }),
    ).toBe(1);
    await db.customerEmailVerification.update({
      where: { id: delivery.verificationId! },
      data: {
        createdAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      },
    });
    expect(
      (await request('/customer-auth/verify-email', 'POST', { token: raw }))
        .status,
    ).toBe(400);
    await db.customerEmailVerification.update({
      where: { id: delivery.verificationId! },
      data: { expiresAt: new Date(Date.now() + 3600000) },
    });
    expect(
      (await request('/customer-auth/verify-email', 'POST', { token: raw }))
        .status,
    ).toBe(200);
    expect(
      (await request('/customer-auth/verify-email', 'POST', { token: raw }))
        .status,
    ).toBe(400);
    const login = await request('/customer-auth/login', 'POST', {
      email: emailA,
      password,
    });
    expect(login.status).toBe(200);
    cookieA = login.cookies[0].split(';')[0];
    expect(login.cookies[0]).toContain('HttpOnly');
    expect(login.cookies[0]).toContain('SameSite=Lax');
    csrfA = (await request('/customer-auth/csrf', 'GET', undefined, cookieA))
      .data.csrfToken;
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookieA)).data
        .customer.emailVerifiedAt,
    ).toBeTruthy();
  });
  it('enforces exact Origin, CSRF, strict bodies and customer/admin realm isolation', async () => {
    const times = interval();
    expect(
      (await request('/booking/hold', 'POST', times, cookieA)).status,
    ).toBe(403);
    expect(
      (await request('/booking/hold', 'POST', times, cookieA, 'wrong')).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/booking/hold',
          'POST',
          times,
          cookieA,
          csrfA,
          'http://localhost:5173.evil.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/booking/hold',
          'POST',
          { ...times, resourceKey: 'private-resource' },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/booking/hold',
          'POST',
          { ...times, status: 'CONFIRMED' },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(400);
    expect((await request('/auth/me', 'GET', undefined, cookieA)).status).toBe(
      401,
    );
    expect(
      (await request('/admin/bookings', 'GET', undefined, cookieA)).status,
    ).toBe(401);
    for (const role of ['ADMIN', 'EDITOR'] as const) {
      const user = await db.user.create({
        data: {
          email: `${randomUUID()}@example.test`,
          passwordHash: await hashPassword(password),
          role,
        },
      });
      const login = await request('/auth/login', 'POST', {
        email: user.email,
        password,
      });
      expect(login.status).toBe(200);
      if (role === 'ADMIN') adminCookie = login.cookies[0].split(';')[0];
      else editorCookie = login.cookies[0].split(';')[0];
    }
    adminCsrf = (await request('/auth/csrf', 'GET', undefined, adminCookie))
      .data.csrfToken;
    adminCookie += `; ${CSRF_COOKIE}=${adminCsrf}`;
    expect(
      (await request('/customer-auth/me', 'GET', undefined, adminCookie))
        .status,
    ).toBe(401);
    expect(
      (await request('/booking/hold', 'POST', times, adminCookie, adminCsrf))
        .status,
    ).toBe(401);
    expect(
      (await request('/admin/bookings', 'GET', undefined, editorCookie)).status,
    ).toBe(403);
  }, 20000);
  it('Phase 2C organizer and Meet routes enforce ADMIN, CSRF, exact Origin, disabled configuration and callback state', async () => {
    for (const path of [
      '/admin/integrations/google/calendar/connect',
      '/admin/bookings/unknown/google-meet',
    ]) {
      expect(
        (await request(path, 'POST', undefined, cookieA, csrfA)).status,
      ).toBe(401);
      expect(
        (await request(path, 'POST', undefined, editorCookie, adminCsrf))
          .status,
      ).toBe(403);
      expect((await request(path, 'POST', undefined, adminCookie)).status).toBe(
        403,
      );
      expect(
        (
          await request(
            path,
            'POST',
            undefined,
            adminCookie,
            adminCsrf,
            'http://localhost:5173.evil.test',
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(
          '/admin/integrations/google/calendar',
          'GET',
          undefined,
          editorCookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          '/integrations/google/calendar/callback?state=bad&code=bad',
          'GET',
          undefined,
          cookieA,
        )
      ).status,
    ).toBe(401);
    const previous = process.env;
    try {
      process.env = { ...previous, GOOGLE_CALENDAR_ENABLED: 'false' };
      expect(
        (
          await request(
            '/admin/integrations/google/calendar',
            'GET',
            undefined,
            adminCookie,
          )
        ).data,
      ).toEqual({ enabled: false, connected: false });
      expect(
        (
          await request(
            '/admin/integrations/google/calendar/connect',
            'POST',
            undefined,
            adminCookie,
            adminCsrf,
          )
        ).status,
      ).toBe(503);
      process.env = {
        ...previous,
        GOOGLE_CALENDAR_ENABLED: 'true',
        GOOGLE_CALENDAR_CLIENT_ID: 'calendar-test',
        GOOGLE_CALENDAR_CLIENT_SECRET: 'fixture',
        GOOGLE_CALENDAR_REDIRECT_URI:
          'http://localhost:3000/api/integrations/google/calendar/callback',
        GOOGLE_CALENDAR_ORGANIZER_EMAIL: 'organizer@example.test',
        GOOGLE_CALENDAR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      };
      const connect = await request(
        '/admin/integrations/google/calendar/connect',
        'POST',
        undefined,
        adminCookie,
        adminCsrf,
      );
      expect(connect.status).toBe(201);
      expect(JSON.stringify(connect.data)).not.toContain('client_secret');
      expect(
        (
          await request(
            '/integrations/google/calendar/callback?state=bad&code=bad',
            'GET',
            undefined,
            adminCookie,
          )
        ).status,
      ).toBe(400);
    } finally {
      process.env = previous;
    }
  });

  it('races HTTP holds, preserves old hold on failed replacement and atomically moves to a free slot', async () => {
    const email = `${randomUUID()}@example.test`;
    await request('/customer-auth/register', 'POST', {
      email,
      name: 'Customer B',
      phone: '0900000001',
      password,
      locale: 'vi',
    });
    await db.customerAccount.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    });
    const login = await request('/customer-auth/login', 'POST', {
      email,
      password,
    });
    cookieB = login.cookies[0].split(';')[0];
    csrfB = (await request('/customer-auth/csrf', 'GET', undefined, cookieB))
      .data.csrfToken;
    const times = interval();
    const raced = await Promise.all([
      request('/booking/hold', 'POST', times, cookieA, csrfA),
      request(
        '/booking/hold',
        'POST',
        { ...times, idempotencyKey: randomUUID() },
        cookieB,
        csrfB,
      ),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    const aWins = raced[0].status === 200;
    const winnerCookie = aWins ? cookieA : cookieB,
      winnerCsrf = aWins ? csrfA : csrfB;
    const loserCookie = aWins ? cookieB : cookieA,
      loserCsrf = aWins ? csrfB : csrfA;
    const winner = raced[aWins ? 0 : 1].data;
    const other = await request(
      '/booking/hold',
      'POST',
      interval(),
      loserCookie,
      loserCsrf,
    );
    expect(other.status).toBe(200);
    expect(
      (
        await request(
          '/booking/hold',
          'POST',
          { ...times, idempotencyKey: randomUUID() },
          loserCookie,
          loserCsrf,
        )
      ).status,
    ).toBe(409);
    expect(
      (await request('/booking/hold', 'GET', undefined, loserCookie)).data.hold
        .id,
    ).toBe(other.data.id);
    const moved = await request(
      '/booking/hold',
      'POST',
      interval(),
      loserCookie,
      loserCsrf,
    );
    expect(moved.status).toBe(200);
    expect(
      (await request('/booking/hold', 'GET', undefined, loserCookie)).data.hold
        .id,
    ).toBe(moved.data.id);
    expect(
      (
        await request(
          `/booking/holds/${winner.id}/release`,
          'POST',
          undefined,
          loserCookie,
          loserCsrf,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/booking/holds/${winner.id}/release`,
          'POST',
          undefined,
          winnerCookie,
          winnerCsrf,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          '/booking/hold',
          'POST',
          { ...times, idempotencyKey: randomUUID() },
          winnerCookie,
          winnerCsrf,
        )
      ).status,
    ).toBe(200);
    const forA = await request(
      '/booking/hold',
      'POST',
      interval(),
      cookieA,
      csrfA,
    );
    heldId = forA.data.id;
  }, 20000);
  it('finalizes exactly once and returns only own bookings without notes/internal metadata', async () => {
    const input = {
      holdId: heldId,
      contactName: 'Customer A',
      contactPhone: '+84 900 000 000',
      contactCompany: 'Company',
      locale: 'en',
      idempotencyKey: randomUUID(),
    };
    expect(
      (
        await request(
          '/booking/finalize',
          'POST',
          { ...input, email: 'other@example.test' },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/booking/finalize',
          'POST',
          { ...input, status: 'CONFIRMED' },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(400);
    const result = await Promise.all([
      request('/booking/finalize', 'POST', input, cookieA, csrfA),
      request('/booking/finalize', 'POST', input, cookieA, csrfA),
    ]);
    expect(result.map((r) => r.status)).toEqual([200, 200]);
    bookingId = result[0].data.id;
    expect(result[1].data.id).toBe(bookingId);
    expect(await db.booking.count({ where: { holdId: heldId } })).toBe(1);
    expect(await db.notificationDelivery.count({ where: { bookingId } })).toBe(
      2,
    );
    expect(
      (await db.booking.findUniqueOrThrow({ where: { id: bookingId } }))
        .contactEmail,
    ).toBe(emailA);
    expect(
      (await request(`/booking/mine/${bookingId}`, 'GET', undefined, cookieB))
        .status,
    ).toBe(404);
    const mine = await request('/booking/mine', 'GET', undefined, cookieA);
    expect(mine.status).toBe(200);
    expect(mine.data.items[0].meetingUrl).toBeNull();
    expect(mine.data.items[0]).not.toHaveProperty('notes');
    expect(mine.data.items[0]).not.toHaveProperty('customerId');
  });
  it('enforces ADMIN workflow, versioned transitions, audit, notes and required notification intents', async () => {
    expect(
      (await request('/admin/bookings', 'GET', undefined, adminCookie)).status,
    ).toBe(200);
    const change = {
      expectedVersion: 1,
      toStatus: 'CONFIRMED',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    };
    for (const meetingUrl of [undefined, 'https://evil.test/abc-defg-hij']) {
      const response = await request(
        `/admin/bookings/${bookingId}/status`,
        'POST',
        {
          expectedVersion: 1,
          toStatus: 'CONFIRMED',
          ...(meetingUrl ? { meetingUrl } : {}),
        },
        adminCookie,
        adminCsrf,
      );
      expect(response.status).toBe(400);
    }
    expect(
      (
        await request(
          `/admin/bookings/${bookingId}/status`,
          'POST',
          change,
          editorCookie,
          adminCsrf,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/admin/bookings/${bookingId}/status`,
          'POST',
          change,
          adminCookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/admin/bookings/${bookingId}/status`,
          'POST',
          change,
          adminCookie,
          adminCsrf,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          `/admin/bookings/${bookingId}/status`,
          'POST',
          change,
          adminCookie,
          adminCsrf,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/admin/bookings/${bookingId}/notes`,
          'POST',
          { text: 'Private internal note' },
          adminCookie,
          adminCsrf,
        )
      ).status,
    ).toBe(201);
    const detail = await request(
      `/admin/bookings/${bookingId}`,
      'GET',
      undefined,
      adminCookie,
    );
    expect(detail.data.events).toHaveLength(2);
    expect(detail.data.notes).toHaveLength(1);
    expect(
      (
        await request(
          `/admin/bookings/${bookingId}/status`,
          'POST',
          {
            expectedVersion: 2,
            toStatus: 'CANCELLED',
            reason: 'Customer informed',
          },
          adminCookie,
          adminCsrf,
        )
      ).status,
    ).toBe(201);
    expect(await db.notificationDelivery.count({ where: { bookingId } })).toBe(
      4,
    );
    const templates = (
      await db.notificationDelivery.findMany({ where: { bookingId } })
    )
      .map((n) => n.template)
      .sort();
    expect(templates).toEqual([
      'BOOKING_CANCELLED_CUSTOMER',
      'BOOKING_CONFIRMED_CUSTOMER',
      'BOOKING_CREATED_ADMIN',
      'BOOKING_CREATED_CUSTOMER',
    ]);
    expect(
      (
        await request(
          '/booking/mine?period=upcoming',
          'GET',
          undefined,
          cookieA,
        )
      ).data.total,
    ).toBe(0);
    expect(
      (
        await request('/booking/mine?period=past', 'GET', undefined, cookieA)
      ).data.items.map((b: { id: string }) => b.id),
    ).toEqual([bookingId]);
    expect(
      (await request(`/booking/mine/${bookingId}`, 'GET', undefined, cookieA))
        .data,
    ).not.toHaveProperty('notes');
    expect(
      (
        await request(
          '/admin/bookings?status=INVALID',
          'GET',
          undefined,
          adminCookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/admin/bookings?search=Customer&status=CANCELLED',
          'GET',
          undefined,
          adminCookie,
        )
      ).data.total,
    ).toBeGreaterThan(0);
  });
  it('rejects expired finalization immediately; release and expiry free availability without cleanup', async () => {
    const input = interval(),
      acquired = await request('/booking/hold', 'POST', input, cookieA, csrfA);
    const hold = await db.bookingHold.findUniqueOrThrow({
      where: { id: acquired.data.id },
    });
    await db.$executeRaw`UPDATE "BookingReservation" SET "createdAt" = clock_timestamp() - interval '11 minutes', "expiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${hold.reservationId}`;
    expect(
      (await request('/booking/hold', 'GET', undefined, cookieA)).data.hold,
    ).toBeNull();
    const available = await request(
      `/booking/availability?${new URLSearchParams({ from: input.requestedStartAt, to: input.requestedEndAt, duration: '60' })}`,
    );
    expect(available.data.periods[0].available).toBe(true);
    expect(
      (
        await request(
          '/booking/finalize',
          'POST',
          {
            holdId: hold.id,
            contactName: 'A',
            contactPhone: '0900000000',
            contactCompany: 'Company',
            locale: 'vi',
            idempotencyKey: randomUUID(),
          },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          '/booking/hold',
          'POST',
          { ...input, idempotencyKey: randomUUID() },
          cookieB,
          csrfB,
        )
      ).status,
    ).toBe(200);
  });
  let recoveryId: string,
    recoveryEmail: string,
    recoveryToken: string,
    recoveryDelivery: string;
  const nextPassword = 'new secure recovery password';
  it('recovery: returns identical accepted responses and serializes repeated forgot requests', async () => {
    for (const key of counters.keys()) counters.set(key, 0);
    recoveryEmail = `${randomUUID()}@example.test`;
    const account = await db.customerAccount.create({
      data: {
        email: recoveryEmail,
        name: 'Recovery customer',
        passwordHash: await hashPassword(password),
        emailVerifiedAt: new Date(),
      },
    });
    recoveryId = account.id;
    const known = await request('/customer-auth/forgot-password', 'POST', {
      email: recoveryEmail,
      locale: 'en',
    });
    const unknown = await request('/customer-auth/forgot-password', 'POST', {
      email: `${randomUUID()}@example.test`,
      locale: 'en',
    });
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.data).toEqual(unknown.data);
    const repeated = await Promise.all([
      request('/customer-auth/forgot-password', 'POST', {
        email: recoveryEmail,
        locale: 'en',
      }),
      request('/customer-auth/forgot-password', 'POST', {
        email: recoveryEmail,
        locale: 'en',
      }),
    ]);
    expect(repeated.map((r) => r.data)).toEqual([known.data, known.data]);
    expect(
      await db.customerPasswordReset.count({
        where: { customerId: recoveryId },
      }),
    ).toBe(1);
    const delivery = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: recoveryId, template: 'CUSTOMER_PASSWORD_RESET' },
    });
    recoveryDelivery = delivery.id;
    recoveryToken = secret.open(
      delivery.encryptedSecret!,
      `password-reset:${delivery.passwordResetId}`,
    );
    const token = await db.customerPasswordReset.findUniqueOrThrow({
      where: { id: delivery.passwordResetId! },
    });
    expect(token.tokenHash).not.toBe(recoveryToken);
    expect(token.tokenHash).toHaveLength(64);
    expect(
      token.expiresAt.getTime() - token.createdAt.getTime(),
    ).toBeGreaterThan(44 * 60000);
    expect(
      await db.notificationDelivery.count({
        where: { customerId: recoveryId },
      }),
    ).toBe(1);
  });
  it('recovery: one reset wins, old passwords and every customer session fail, CMS and verification survive', async () => {
    const sessions = app.get(CustomerSessionService),
      first = await sessions.issue(recoveryId),
      second = await sessions.issue(recoveryId);
    const verified = (
      await db.customerAccount.findUniqueOrThrow({ where: { id: recoveryId } })
    ).emailVerifiedAt;
    const body = {
      token: recoveryToken,
      password: nextPassword,
      confirmPassword: nextPassword,
    };
    const outcomes = await Promise.all([
      request('/customer-auth/reset-password', 'POST', body, adminCookie),
      request('/customer-auth/reset-password', 'POST', body),
    ]);
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(
      (await request('/customer-auth/reset-password', 'POST', body)).data
        .message,
    ).toBe('INVALID_PASSWORD_RESET_TOKEN');
    for (const token of [first, second])
      expect(
        (
          await request(
            '/customer-auth/me',
            'GET',
            undefined,
            `neotek_customer_session=${token}`,
          )
        ).status,
      ).toBe(401);
    expect(
      (await request('/auth/me', 'GET', undefined, adminCookie)).status,
    ).toBe(200);
    expect(
      (await request('/auth/me', 'GET', undefined, editorCookie)).status,
    ).toBe(200);
    const account = await db.customerAccount.findUniqueOrThrow({
      where: { id: recoveryId },
    });
    expect(account.emailVerifiedAt).toEqual(verified);
    expect(account.authVersion).toBe(1);
    expect(await verifyPassword(account.passwordHash!, password)).toBe(false);
    expect(await verifyPassword(account.passwordHash!, nextPassword)).toBe(
      true,
    );
    for (const key of counters.keys()) counters.set(key, 0);
    expect(
      (
        await request('/customer-auth/login', 'POST', {
          email: recoveryEmail,
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request('/customer-auth/login', 'POST', {
          email: recoveryEmail,
          password: nextPassword,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await db.notificationDelivery.findUniqueOrThrow({
          where: { id: recoveryDelivery },
        })
      ).encryptedSecret,
    ).toBeNull();
  });
  it('recovery: rejects rotated, expired and random tokens and preserves an unverified account', async () => {
    const account = await db.customerAccount.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: 'Unverified recovery',
        passwordHash: await hashPassword(password),
      },
    });
    const recovery = new CustomerPasswordRecoveryService(
      db as PrismaService,
      cache as unknown as CacheService,
      notifications,
      secret,
    );
    const issue = () =>
      recovery.forgot({ email: account.email, locale: 'vi' }, randomUUID());
    await issue();
    const old = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: account.id },
    });
    const oldRaw = secret.open(
      old.encryptedSecret!,
      `password-reset:${old.passwordResetId}`,
    );
    await db.customerPasswordReset.update({
      where: { id: old.passwordResetId! },
      data: { createdAt: new Date(Date.now() - 61000) },
    });
    await issue();
    expect(
      (
        await db.notificationDelivery.findUniqueOrThrow({
          where: { id: old.id },
        })
      ).status,
    ).toBe('REVOKED');
    const reset = (token: string) =>
      recovery.reset(
        { token, password: nextPassword, confirmPassword: nextPassword },
        randomUUID(),
      );
    await expect(reset(oldRaw)).rejects.toThrow('INVALID_PASSWORD_RESET_TOKEN');
    await expect(reset(randomBytes(32).toString('base64url'))).rejects.toThrow(
      'INVALID_PASSWORD_RESET_TOKEN',
    );
    const current = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: account.id, status: 'PENDING' },
    });
    const currentRaw = secret.open(
      current.encryptedSecret!,
      `password-reset:${current.passwordResetId}`,
    );
    await db.customerPasswordReset.update({
      where: { id: current.passwordResetId! },
      data: {
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 61000),
      },
    });
    await expect(reset(currentRaw)).rejects.toThrow(
      'INVALID_PASSWORD_RESET_TOKEN',
    );
    expect(
      (
        await db.customerAccount.findUniqueOrThrow({
          where: { id: account.id },
        })
      ).authVersion,
    ).toBe(0);
    await issue();
    const fresh = await db.customerPasswordReset.findFirstOrThrow({
      where: { customerId: account.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const mail = await db.notificationDelivery.findFirstOrThrow({
      where: { passwordResetId: fresh.id },
    });
    await reset(
      secret.open(mail.encryptedSecret!, `password-reset:${fresh.id}`),
    );
    expect(
      (
        await db.customerAccount.findUniqueOrThrow({
          where: { id: account.id },
        })
      ).emailVerifiedAt,
    ).toBeNull();
  });
  it('recovery: durable provider failures are safe and recoverable without deleting accounts', async () => {
    const account = await db.customerAccount.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: 'Delivery retry',
        passwordHash: await hashPassword(password),
      },
    });
    const recovery = new CustomerPasswordRecoveryService(
      db as PrismaService,
      cache as unknown as CacheService,
      notifications,
      secret,
    );
    expect(
      await recovery.forgot(
        { email: account.email, locale: 'en' },
        randomUUID(),
      ),
    ).toEqual({ accepted: true });
    const mail = await db.notificationDelivery.findFirstOrThrow({
      where: { customerId: account.id },
    });
    await db.notificationDelivery.updateMany({
      where: { id: { not: mail.id }, status: 'PENDING' },
      data: { nextAttemptAt: new Date(Date.now() + 86400000) },
    });
    await notifications.dispatchOne(
      db,
      {
        send: async () => {
          throw new Error('private provider credential');
        },
      },
      secret,
    );
    const failed = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: mail.id },
    });
    expect(failed.status).toBe('PENDING');
    expect(failed.lastErrorCode).toBe('EMAIL_DELIVERY_FAILED');
    expect(failed.attempts).toBe(1);
    expect(await db.customerAccount.count({ where: { id: account.id } })).toBe(
      1,
    );
    await db.notificationDelivery.update({
      where: { id: mail.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const send = jest.fn().mockResolvedValue({ messageId: 'recovered' });
    await notifications.dispatchOne(db, { send }, secret);
    expect(send.mock.calls[0][0].passwordResetToken).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(send.mock.calls[0][0].verificationToken).toBeUndefined();
    const sent = await db.notificationDelivery.findUniqueOrThrow({
      where: { id: mail.id },
    });
    expect(sent.status).toBe('SENT');
    expect(sent.encryptedSecret).toBeNull();
  });
  it('recovery: enforces Origin, body limits, strict validation and attempt budgets', async () => {
    for (const key of counters.keys()) counters.set(key, 0);
    const body = { email: recoveryEmail, locale: 'en' };
    for (const endpoint of [
      '/customer-auth/forgot-password',
      '/customer-auth/reset-password',
    ])
      expect(
        (await request(endpoint, 'POST', body, '', '', 'https://evil.example'))
          .status,
      ).toBe(403);
    expect(
      (
        await request('/customer-auth/forgot-password', 'POST', {
          ...body,
          role: 'ADMIN',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/customer-auth/forgot-password', 'POST', {
          ...body,
          email: 'invalid',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/customer-auth/forgot-password', 'POST', {
          ...body,
          extra: 'x'.repeat(2 * 1024 * 1024),
        })
      ).status,
    ).toBe(413);
    for (const input of [
      { token: recoveryToken, password: 'short', confirmPassword: 'short' },
      {
        token: recoveryToken,
        password: nextPassword,
        confirmPassword: 'mismatched long password',
      },
    ])
      expect(
        (await request('/customer-auth/reset-password', 'POST', input)).status,
      ).toBe(400);
    for (const key of counters.keys())
      if (key.includes('customer:recovery:forgot-ip:')) counters.set(key, 10);
    expect(
      (await request('/customer-auth/forgot-password', 'POST', body)).status,
    ).toBe(429);
    for (const key of counters.keys())
      if (key.includes('customer:recovery:reset-ip:')) counters.set(key, 20);
    expect(
      (await request('/customer-auth/reset-password', 'POST', {})).status,
    ).toBe(429);
    for (const key of counters.keys()) counters.set(key, 0);
  });
  it('bounds login, registration, resend and mutation rates and safely logs out', async () => {
    // Thresholds are exercised without spending Argon2 time on rejected requests.
    for (const key of counters.keys())
      if (key.includes('customer:ratelimit:login-ip:')) counters.set(key, 5);
    expect(
      (
        await request('/customer-auth/login', 'POST', {
          email: emailA,
          password,
        })
      ).status,
    ).toBe(429);
    for (const key of counters.keys())
      if (key.includes('customer:ratelimit:register-ip:')) counters.set(key, 5);
    expect(
      (
        await request('/customer-auth/register', 'POST', {
          email: emailA,
          password,
          name: 'A',
          phone: '0900000000',
          locale: 'vi',
        })
      ).status,
    ).toBe(429);
    for (const key of counters.keys())
      if (key.includes('customer:ratelimit:verification-customer:'))
        counters.set(key, 5);
    expect(
      (
        await request(
          '/customer-auth/resend-verification',
          'POST',
          { email: emailA, locale: 'vi' },
          cookieA,
          csrfA,
        )
      ).status,
    ).toBe(429);
    const sessions = app.get(CustomerSessionService);
    counters.set(sessions.key(accountA, 'rate:mutation'), 60);
    expect(
      (await request('/booking/hold', 'POST', interval(), cookieA, csrfA))
        .status,
    ).toBe(429);
    counters.set(sessions.key(accountA, 'rate:mutation'), 0);
    const logout = await request(
      '/customer-auth/logout',
      'POST',
      undefined,
      cookieA,
      csrfA,
    );
    expect(logout.status).toBe(200);
    expect(logout.cookies[0]).toContain('Expires=Thu, 01 Jan 1970');
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookieA)).status,
    ).toBe(401);
    expect(
      (await request('/auth/me', 'GET', undefined, adminCookie)).status,
    ).toBe(200);
  });
});
