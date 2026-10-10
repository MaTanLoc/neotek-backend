import {
  Injectable,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { databaseTime, parseInput } from '../booking/booking-domain';
import {
  GoogleTokenVerifier,
  googleCustomerConfiguration,
} from './google-token-verifier';

const inputSchema = z
  .object({
    credential: z
      .string()
      .min(20)
      .max(8192)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  })
  .strict();
const denied = () =>
  new UnauthorizedException('Google login could not be completed');

@Injectable()
export class CustomerGoogleService {
  private readonly db: PrismaService;
  private readonly cache: CacheService;
  private readonly verifier: GoogleTokenVerifier;
  constructor(
    db: PrismaService,
    cache: CacheService,
    verifier: GoogleTokenVerifier,
  ) {
    this.db = db;
    this.cache = cache;
    this.verifier = verifier;
  }

  async authenticate(input: unknown, ip: string) {
    let attempts: number;
    try {
      attempts = await this.cache.incrementWithExpiry(
        `customer:ratelimit:google-ip:${createHash('sha256').update(ip).digest('hex')}`,
        60,
      );
    } catch {
      throw new ServiceUnavailableException('Customer service unavailable');
    }
    if (attempts > 10) throw new HttpException('Too many attempts', 429);
    const { credential } = parseInput(inputSchema, input);
    if (!googleCustomerConfiguration().enabled)
      throw new ServiceUnavailableException('Google login unavailable');
    const identity = await this.verifier.verify(credential);
    // Serialize by stable subject, then email. Unique constraints also protect
    // registration (which does not take these locks) and alternate subjects.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`google-sub:${identity.subject}`}, 0))::text`;
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`google-email:${identity.email}`}, 0))::text`;
          const link = await tx.customerOAuthIdentity.findUnique({
            where: {
              provider_providerSubject: {
                provider: 'GOOGLE',
                providerSubject: identity.subject,
              },
            },
          });
          let account = await tx.customerAccount.findUnique({
            where: link ? { id: link.customerId } : { email: identity.email },
          });
          if (account) {
            await tx.$queryRaw`SELECT "id" FROM "CustomerAccount" WHERE "id" = ${account.id} FOR UPDATE`;
            account = await tx.customerAccount.findUniqueOrThrow({
              where: { id: account.id },
            });
            if (!account.active) throw denied();
            if (!link) {
              // Google's verified third-party email may reflect old ownership.
              if (!identity.authoritativeEmail) throw denied();
              const other = await tx.customerOAuthIdentity.findUnique({
                where: {
                  customerId_provider: {
                    customerId: account.id,
                    provider: 'GOOGLE',
                  },
                },
              });
              if (other) throw denied();
            }
          } else {
            account = await tx.customerAccount.create({
              data: {
                email: identity.email,
                name: identity.name,
                emailVerifiedAt: await databaseTime(tx),
              },
            });
          }
          if (!link)
            await tx.customerOAuthIdentity.create({
              data: {
                customerId: account.id,
                provider: 'GOOGLE',
                providerSubject: identity.subject,
              },
            });
          // A linked subject whose Google email changed cannot verify a different
          // canonical NeoTek address. Keep the existing address and name intact.
          if (
            !account.emailVerifiedAt &&
            account.email === identity.email &&
            identity.authoritativeEmail
          ) {
            const now = await databaseTime(tx);
            account = await tx.customerAccount.update({
              where: { id: account.id },
              data: { emailVerifiedAt: now },
            });
            await tx.customerEmailVerification.updateMany({
              where: { customerId: account.id, usedAt: null, revokedAt: null },
              data: { revokedAt: now },
            });
            await tx.notificationDelivery.updateMany({
              where: {
                customerId: account.id,
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
          }
          return {
            realm: 'customer' as const,
            customerId: account.id,
            email: account.email,
            name: account.name,
            emailVerifiedAt: account.emailVerifiedAt,
            authVersion: account.authVersion,
          };
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          attempt < 2
        )
          continue;
        throw error;
      }
    }
    throw denied();
  }
}
