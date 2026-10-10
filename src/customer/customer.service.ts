import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { hashPassword, verifyPassword } from '../auth/password.util';
import {
  customerIdentity,
  CustomerPrincipal,
  databaseTime,
  parseInput,
} from '../booking/booking-domain';
import { NotificationService } from '../notification/notification.service';
import { VerificationSecret } from '../notification/verification-secret';
import { customerEmail, customerPassword } from './customer-input';

const accountInput = z
  .object({
    email: customerEmail,
    phone: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^\+?[0-9 () .-]+$/)
      .refine((value) => value.replace(/\D/g, '').length >= 7),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine(
        (value) =>
          !Array.from(value).some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          ),
      ),
    password: customerPassword,
    locale: z.enum(['vi', 'en']),
  })
  .strict();
const loginInput = accountInput.pick({ email: true, password: true });
const dummyHash =
  '$argon2id$v=19$m=65536,t=3,p=4$wb24d1PJKvzZBGU3IFpR/A$8yee02HkWPo4d12Ayme7MsDuYEMKJBEBbLycxxL+Ues';

// Customer identity is independent of CMS users and authorization.
export class CustomerService {
  private readonly db: PrismaService;
  private readonly notifications: NotificationService;
  private readonly cache: CacheService;
  private readonly secrets: VerificationSecret;
  constructor(
    db: PrismaService,
    notifications: NotificationService,
    cache: CacheService,
    secrets: VerificationSecret,
  ) {
    this.db = db;
    this.notifications = notifications;
    this.cache = cache;
    this.secrets = secrets;
  }

  private async rate(
    bucket: string,
    identifier: string,
    limit: number,
    seconds: number,
  ) {
    let count: number;
    try {
      count = await this.cache.incrementWithExpiry(
        `customer:ratelimit:${bucket}:${createHash('sha256').update(identifier).digest('hex')}`,
        seconds,
      );
    } catch {
      throw new ServiceUnavailableException('Customer service unavailable');
    }
    if (count > limit) throw new HttpException('Too many attempts', 429);
  }

  async register(input: unknown, ip: string): Promise<{ accepted: true }> {
    await this.rate('register-ip', ip, 5, 3600);
    const data = parseInput(accountInput, input);
    await this.rate('register-email', data.email, 5, 3600);
    // Hash even for duplicates; the public result never reveals existence and
    // never creates a session. Login is an independent deliberate operation.
    const passwordHash = await hashPassword(data.password);
    try {
      await this.db.$transaction(async (tx) => {
        const account = await tx.customerAccount.create({
          data: {
            email: data.email,
            name: data.name,
            phone: data.phone,
            passwordHash,
          },
        });
        await this.issue(tx, account.id, data.email, data.locale);
      });
    } catch (error) {
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ))
        throw error;
    }
    return { accepted: true };
  }

  async authenticate(input: unknown, ip: string) {
    await this.rate('login-ip', ip, 5, 60);
    const data = parseInput(loginInput, input);
    await this.rate('login-email', data.email, 20, 60);
    const account = await this.db.customerAccount.findUnique({
      where: { email: data.email },
    });
    const valid = await verifyPassword(
      account?.passwordHash ?? dummyHash,
      data.password,
    );
    if (!account || !account.passwordHash || !account.active || !valid)
      throw new UnauthorizedException('Invalid email or password');
    if (!account.emailVerifiedAt)
      throw new ForbiddenException('EMAIL_NOT_VERIFIED');
    return {
      realm: 'customer' as const,
      customerId: account.id,
      email: account.email,
      name: account.name,
      emailVerifiedAt: account.emailVerifiedAt,
      authVersion: account.authVersion,
    };
  }

  async resendByEmail(input: unknown, ip: string): Promise<{ accepted: true }> {
    await this.rate('resend-ip', ip, 10, 3600);
    const data = parseInput(
      z.object({ email: customerEmail, locale: z.enum(['vi', 'en']) }).strict(),
      input,
    );
    await this.rate('resend-email', data.email, 5, 3600);
    const account = await this.db.customerAccount.findUnique({
      where: { email: data.email },
      select: { id: true },
    });
    if (account)
      await this.resend(
        { realm: 'customer', customerId: account.id },
        data.locale,
        ip,
      );
    return { accepted: true };
  }

  async resend(
    principal: CustomerPrincipal,
    locale: 'vi' | 'en',
    ip: string,
  ): Promise<{ accepted: true }> {
    const id = customerIdentity(principal);
    if (!['vi', 'en'].includes(locale))
      throw new BadRequestException('Invalid input');
    await this.rate('verification-ip', ip, 10, 3600);
    await this.rate('verification-customer', id, 5, 3600);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${id} FOR UPDATE`;
      const account = await tx.customerAccount.findUnique({ where: { id } });
      if (!account?.active) return;
      const now = await databaseTime(tx);
      // Identical response for verified/cooldown; no token or account state leaks.
      if (
        account.emailVerifiedAt ||
        (account.verificationIssuedAt &&
          now.getTime() - account.verificationIssuedAt.getTime() < 60000)
      )
        return;
      await this.issue(tx, id, account.email, locale);
    });
    return { accepted: true };
  }

  async verify(rawToken: unknown, ip: string): Promise<{ verified: true }> {
    await this.rate('verify-ip', ip, 20, 3600);
    if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawToken))
      throw new BadRequestException('Invalid verification token');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await this.db.$transaction(async (tx) => {
      const candidate = await tx.customerEmailVerification.findUnique({
        where: { tokenHash },
      });
      if (!candidate)
        throw new BadRequestException('Invalid verification token');
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${candidate.customerId} FOR UPDATE`;
      const token = await tx.customerEmailVerification.findUniqueOrThrow({
        where: { tokenHash },
      });
      const account = await tx.customerAccount.findUniqueOrThrow({
        where: { id: token.customerId },
      });
      const now = await databaseTime(tx);
      if (
        !account.active ||
        token.usedAt ||
        token.revokedAt ||
        token.expiresAt <= now
      )
        throw new BadRequestException('Invalid verification token');
      await tx.customerEmailVerification.update({
        where: { id: token.id },
        data: { usedAt: now },
      });
      await tx.customerAccount.update({
        where: { id: token.customerId },
        data: { emailVerifiedAt: now },
      });
      await tx.customerEmailVerification.updateMany({
        where: {
          customerId: token.customerId,
          id: { not: token.id },
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await tx.notificationDelivery.updateMany({
        where: {
          customerId: token.customerId,
          verificationId: { not: null },
          status: { in: ['PENDING', 'PROCESSING'] },
        },
        data: {
          status: 'REVOKED',
          encryptedSecret: null,
          lockedAt: null,
          lockToken: null,
        },
      });
    });
    return { verified: true };
  }

  private async issue(
    tx: Prisma.TransactionClient,
    customerId: string,
    email: string,
    locale: string,
  ) {
    const now = await databaseTime(tx);
    await tx.customerEmailVerification.updateMany({
      where: { customerId, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.notificationDelivery.updateMany({
      where: {
        customerId,
        verificationId: { not: null },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: {
        status: 'REVOKED',
        encryptedSecret: null,
        lockToken: null,
        lockedAt: null,
      },
    });
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await tx.customerEmailVerification.create({
      data: {
        id,
        customerId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(now.getTime() + 3600000),
      },
    });
    await tx.customerAccount.update({
      where: { id: customerId },
      data: { verificationIssuedAt: now },
    });
    await this.notifications.enqueue(tx, {
      deduplicationKey: `verify:${id}`,
      customerId,
      verificationId: id,
      template: 'CUSTOMER_EMAIL_VERIFICATION',
      recipient: email,
      locale,
      payload: {},
      encryptedSecret: this.secrets.seal(token, id),
    });
  }
}
