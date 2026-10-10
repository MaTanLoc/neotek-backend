import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';

export const CUSTOMER_COOKIE = 'neotek_customer_session';
export const CUSTOMER_TTL = 28800;

@Injectable()
export class CustomerSessionService {
  private readonly cache: CacheService;
  private readonly db: PrismaService;
  constructor(cache: CacheService, db: PrismaService) {
    this.cache = cache;
    this.db = db;
  }
  key(token: string, kind = 'session') {
    return `customer:${kind}:${createHash('sha256').update(token).digest('hex')}`;
  }
  private async store<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new ServiceUnavailableException('Customer service unavailable');
    }
  }
  async issue(customerId: string, expectedVersion?: number) {
    const account = await this.db.customerAccount.findUnique({
      where: { id: customerId },
      select: { active: true, authVersion: true, emailVerifiedAt: true },
    });
    if (
      !account?.active ||
      !account.emailVerifiedAt ||
      (expectedVersion !== undefined &&
        expectedVersion !== (account.authVersion ?? 0))
    )
      throw new UnauthorizedException('Invalid session');
    const token = randomBytes(32).toString('base64url');
    await this.store(() =>
      this.cache.set(
        this.key(token),
        JSON.stringify({
          realm: 'customer',
          customerId,
          authVersion: account.authVersion ?? 0,
        }),
        CUSTOMER_TTL,
      ),
    );
    return token;
  }
  async resolve(token: unknown) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new UnauthorizedException('Customer authentication required');
    const value = await this.store(() => this.cache.get(this.key(token)));
    let session: { realm?: string; customerId?: string; authVersion?: number };
    try {
      session = JSON.parse(value ?? 'null');
    } catch {
      throw new UnauthorizedException('Invalid session');
    }
    if (session?.realm !== 'customer' || typeof session.customerId !== 'string')
      throw new UnauthorizedException('Invalid session');
    const customer = await this.db.customerAccount.findUnique({
      where: { id: session.customerId },
      select: {
        id: true,
        name: true,
        email: true,
        active: true,
        emailVerifiedAt: true,
        authVersion: true,
      },
    });
    if (customer?.active && !customer.emailVerifiedAt) {
      await this.revoke(token);
      throw new UnauthorizedException('EMAIL_NOT_VERIFIED');
    }
    if (
      !customer?.active ||
      (session.authVersion ?? 0) !== (customer.authVersion ?? 0)
    )
      throw new UnauthorizedException('Invalid session');
    return {
      realm: 'customer' as const,
      customerId: customer.id,
      name: customer.name,
      email: customer.email,
      emailVerifiedAt: customer.emailVerifiedAt,
    };
  }
  async csrf(token: string) {
    const csrf = await this.store(() =>
      this.cache.getOrCreateSessionToken(
        this.key(token),
        this.key(token, 'csrf'),
        randomBytes(32).toString('base64url'),
      ),
    );
    if (!csrf) throw new UnauthorizedException('Invalid session');
    return csrf;
  }
  async validateCsrf(token: string, value: unknown) {
    const expected = await this.store(() =>
      this.cache.get(this.key(token, 'csrf')),
    );
    if (
      typeof value !== 'string' ||
      !expected ||
      Buffer.byteLength(value) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(expected))
    )
      throw new ForbiddenException('Invalid CSRF token');
  }
  async revoke(token: string) {
    await this.store(async () => {
      await this.cache.del(this.key(token));
      await this.cache.del(this.key(token, 'csrf'));
    });
  }
  async rate(identity: string, bucket: string, limit = 60) {
    const count = await this.store(() =>
      this.cache.incrementWithExpiry(this.key(identity, `rate:${bucket}`), 60),
    );
    if (count > limit) throw new HttpException('Too many requests', 429);
  }
}
