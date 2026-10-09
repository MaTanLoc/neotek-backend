import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { NotificationService } from '../notification/notification.service';
import { VerificationSecret } from '../notification/verification-secret';
import { databaseTime, parseInput } from '../booking/booking-domain';
import { hashPassword } from '../auth/password.util';
import { customerEmail, customerPassword } from './customer-input';

const forgotInput = z
  .object({ email: customerEmail, locale: z.enum(['vi', 'en']) })
  .strict();
const resetInput = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: customerPassword,
    confirmPassword: customerPassword,
  })
  .strict()
  .refine((data) => data.password === data.confirmPassword);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function passwordResetMinutes(env = process.env) {
  const minutes = Number(env.CUSTOMER_PASSWORD_RESET_MINUTES ?? 45);
  if (!Number.isInteger(minutes) || minutes < 30 || minutes > 60)
    throw new Error('Invalid password reset expiry');
  return minutes;
}

export class CustomerPasswordRecoveryService {
  private readonly db: PrismaService;
  private readonly cache: CacheService;
  private readonly notifications: NotificationService;
  private readonly secrets: VerificationSecret;
  constructor(
    db: PrismaService,
    cache: CacheService,
    notifications: NotificationService,
    secrets: VerificationSecret,
  ) {
    this.db = db;
    this.cache = cache;
    this.notifications = notifications;
    this.secrets = secrets;
  }
  private async rate(
    bucket: string,
    identity: string,
    limit: number,
    seconds = 3600,
  ) {
    let count: number;
    try {
      count = await this.cache.incrementWithExpiry(
        `customer:recovery:${bucket}:${digest(identity)}`,
        seconds,
      );
    } catch {
      throw new ServiceUnavailableException('Customer service unavailable');
    }
    if (count > limit) throw new HttpException('Too many attempts', 429);
  }
  async forgot(input: unknown, ip: string): Promise<{ accepted: true }> {
    await this.rate('forgot-ip', ip, 10);
    const data = parseInput(forgotInput, input);
    await this.rate('forgot-email', data.email, 5);
    const raw = randomBytes(32).toString('base64url'),
      id = randomUUID();
    await this.db.$transaction(async (tx) => {
      const [account] = await tx.$queryRaw<
        { id: string; active: boolean }[]
      >`SELECT "id", "active" FROM "CustomerAccount" WHERE "email" = ${data.email} FOR UPDATE`;
      if (!account?.active) return;
      const now = await databaseTime(tx);
      const latest = await tx.customerPasswordReset.findFirst({
        where: { customerId: account.id },
        orderBy: { createdAt: 'desc' },
      });
      // Concurrent requests and lost-response retries reuse the pending intent.
      // A deliberate request after the cooldown rotates older bearer tokens.
      if (latest && now.getTime() - latest.createdAt.getTime() < 60000) return;
      await tx.customerPasswordReset.updateMany({
        where: { customerId: account.id, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.revokeDeliveries(tx, account.id);
      await tx.customerPasswordReset.create({
        data: {
          id,
          customerId: account.id,
          tokenHash: digest(raw),
          expiresAt: new Date(now.getTime() + passwordResetMinutes() * 60000),
        },
      });
      await this.notifications.enqueue(tx, {
        deduplicationKey: `password-reset:${id}`,
        customerId: account.id,
        passwordResetId: id,
        template: 'CUSTOMER_PASSWORD_RESET',
        recipient: data.email,
        locale: data.locale,
        payload: {},
        encryptedSecret: this.secrets.seal(raw, `password-reset:${id}`),
      });
    });
    return { accepted: true };
  }
  private revokeDeliveries(tx: Prisma.TransactionClient, customerId: string) {
    return tx.notificationDelivery.updateMany({
      where: {
        customerId,
        passwordResetId: { not: null },
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: {
        status: 'REVOKED',
        encryptedSecret: null,
        lockedAt: null,
        lockToken: null,
      },
    });
  }
  async reset(input: unknown, ip: string): Promise<{ reset: true }> {
    await this.rate('reset-ip', ip, 20);
    const data = parseInput(resetInput, input);
    await this.rate('reset-token', data.token, 5, 900);
    const tokenHash = digest(data.token);
    await this.db.$transaction(async (tx) => {
      const candidate = await tx.customerPasswordReset.findUnique({
        where: { tokenHash },
      });
      if (!candidate)
        throw new BadRequestException('INVALID_PASSWORD_RESET_TOKEN');
      await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${candidate.customerId} FOR UPDATE`;
      const token = await tx.customerPasswordReset.findUniqueOrThrow({
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
        throw new BadRequestException('INVALID_PASSWORD_RESET_TOKEN');
      const passwordHash = await hashPassword(data.password);
      await tx.customerAccount.update({
        where: { id: account.id },
        data: { passwordHash, authVersion: { increment: 1 } },
      });
      await tx.customerPasswordReset.update({
        where: { id: token.id },
        data: { usedAt: now },
      });
      await tx.customerPasswordReset.updateMany({
        where: {
          customerId: account.id,
          id: { not: token.id },
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      await this.revokeDeliveries(tx, account.id);
    });
    return { reset: true };
  }
}
