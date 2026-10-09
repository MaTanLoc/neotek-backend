/* global beforeAll, afterAll */
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { CustomerController } from '../customer/customer.controller';
import { CustomerService } from '../customer/customer.service';
import { CustomerPasswordRecoveryService } from '../customer/customer-password-recovery.service';
import { CustomerSessionService } from '../customer/customer-session.service';
import {
  CustomerGuard,
  CustomerMutationGuard,
} from '../customer/customer.guards';
import { BookingController } from './booking.controller';
import { AdminBookingController } from './admin-booking.controller';
import { BookingService } from './booking.service';
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
      ],
      providers: [
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
  it('registers safely, accepts duplicates, authenticates and restores an unverified customer session', async () => {
    emailA = `${randomUUID()}@example.test`;
    const body = { email: emailA, name: 'Customer A', password, locale: 'en' };
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
    expect(login.status).toBe(200);
    cookieA = login.cookies[0].split(';')[0];
    expect(cookieA).toMatch(/^neotek_customer_session=/);
    expect(login.cookies[0]).toContain('HttpOnly');
    expect(login.cookies[0]).toContain('SameSite=Lax');
    expect(login.data.customer).not.toHaveProperty('passwordHash');
    accountA = login.data.customer.customerId;
    expect(
      (await request('/customer-auth/me', 'GET', undefined, cookieA)).data
        .customer.emailVerifiedAt,
    ).toBeNull();
    csrfA = (await request('/customer-auth/csrf', 'GET', undefined, cookieA))
      .data.csrfToken;
    expect(
      (await request('/customer-auth/csrf', 'GET', undefined, cookieA)).data
        .csrfToken,
    ).toBe(csrfA);
    expect(
      await request('/booking/hold', 'POST', interval(), cookieA, csrfA),
    ).toMatchObject({
      status: 403,
      data: { message: 'EMAIL_VERIFICATION_REQUIRED' },
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
    ).toBe(403);
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
          { locale: 'en' },
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
  it('races HTTP holds, preserves old hold on failed replacement and atomically moves to a free slot', async () => {
    const email = `${randomUUID()}@example.test`;
    await request('/customer-auth/register', 'POST', {
      email,
      name: 'Customer B',
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
    const change = { expectedVersion: 1, toStatus: 'CONFIRMED' };
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
    expect(await verifyPassword(account.passwordHash, password)).toBe(false);
    expect(await verifyPassword(account.passwordHash, nextPassword)).toBe(true);
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
          { locale: 'vi' },
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
