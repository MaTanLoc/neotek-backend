import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { databaseTime } from '../booking/booking-domain';
import { VerificationSecret } from './verification-secret';
import { withDeadline } from '../config/deadline';

export interface EmailProvider {
  // eslint-disable-next-line no-unused-vars -- Type-only adapter contract.
  send(message: {
    template: string;
    recipient: string;
    locale: string;
    payload: Prisma.JsonValue;
    verificationToken?: string;
    passwordResetToken?: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}

@Injectable()
export class NotificationService {
  enqueue(
    tx: Prisma.TransactionClient,
    data: Prisma.NotificationDeliveryUncheckedCreateInput,
  ) {
    return tx.notificationDelivery.create({ data });
  }

  // Provider work occurs outside the domain transaction, with bounded retries.
  async dispatchOne(
    db: PrismaClient,
    provider: EmailProvider,
    secrets: VerificationSecret,
  ): Promise<boolean> {
    const delivery = await db.$transaction(async (tx) => {
      const now = await databaseTime(tx);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "NotificationDelivery"
        WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= ${now})
          OR ("status" = 'PROCESSING' AND "lockedAt" <= ${new Date(now.getTime() - 300000)})
        ORDER BY "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!row) return null;
      const item = await tx.notificationDelivery.findUniqueOrThrow({
        where: { id: row.id },
        include: { verification: true, passwordReset: true },
      });
      const securityToken = item.verification ?? item.passwordReset;
      if (
        securityToken &&
        (securityToken.revokedAt ||
          securityToken.usedAt ||
          securityToken.expiresAt <= now)
      ) {
        await tx.notificationDelivery.update({
          where: { id: item.id },
          data: {
            status: 'REVOKED',
            encryptedSecret: null,
            lockToken: null,
            lockedAt: null,
          },
        });
        return null;
      }
      if (item.attempts >= 5) {
        await tx.notificationDelivery.update({
          where: { id: item.id },
          data: {
            status: 'FAILED',
            lastErrorCode: 'ATTEMPTS_EXHAUSTED',
            lockToken: null,
            lockedAt: null,
            encryptedSecret: null,
          },
        });
        return null;
      }
      return tx.notificationDelivery.update({
        where: { id: item.id },
        data: {
          status: 'PROCESSING',
          attempts: { increment: 1 },
          lockedAt: now,
          lockToken: randomUUID(),
        },
      });
    });
    if (!delivery) return false;
    try {
      const result = await withDeadline(
        provider.send({
          template: delivery.template,
          recipient: delivery.recipient,
          locale: delivery.locale,
          payload: delivery.payload,
          idempotencyKey: delivery.deduplicationKey,
          ...(delivery.encryptedSecret && delivery.passwordResetId
            ? {
                passwordResetToken: secrets.open(
                  delivery.encryptedSecret,
                  `password-reset:${delivery.passwordResetId}`,
                ),
              }
            : {}),
          ...(delivery.encryptedSecret && delivery.verificationId
            ? {
                verificationToken: secrets.open(
                  delivery.encryptedSecret,
                  delivery.verificationId,
                ),
              }
            : {}),
        }),
        10000,
      );
      await db.notificationDelivery.updateMany({
        where: {
          id: delivery.id,
          status: 'PROCESSING',
          lockToken: delivery.lockToken,
        },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result.messageId.slice(0, 240),
          encryptedSecret: null,
          lockToken: null,
          lockedAt: null,
          lastErrorCode: null,
        },
      });
    } catch {
      await db.notificationDelivery.updateMany({
        where: {
          id: delivery.id,
          status: 'PROCESSING',
          lockToken: delivery.lockToken,
        },
        data: {
          status: delivery.attempts >= 5 ? 'FAILED' : 'PENDING',
          nextAttemptAt: new Date(
            Date.now() + Math.min(3600000, 30000 * 2 ** delivery.attempts),
          ),
          lastErrorCode: 'EMAIL_DELIVERY_FAILED',
          lockToken: null,
          lockedAt: null,
          ...(delivery.attempts >= 5 ? { encryptedSecret: null } : {}),
        },
      });
    }
    return true;
  }
}
