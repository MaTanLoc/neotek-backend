import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerSessionService } from './customer-session.service';
import { AuthService } from '../auth/auth.service';

const redisTest = process.env.AUTH_REDIS_TEST_URL ? describe : describe.skip;
redisTest('Customer sessions with real Redis', () => {
  it('uses atomic CSRF, absolute TTL, realm isolation and independent logout', async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = process.env.AUTH_REDIS_TEST_URL;
    const cache = new CacheService(),
      redis = createClient({ url: process.env.AUTH_REDIS_TEST_URL });
    const id = randomUUID();
    const db = {
      customerAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id,
          active: true,
          email: 'session@example.test',
          name: 'Session test',
          emailVerifiedAt: new Date(),
        }),
      },
      user: { findUnique: jest.fn() },
    };
    const sessions = new CustomerSessionService(
      cache,
      db as unknown as PrismaService,
    );
    const admin = new AuthService(db as unknown as PrismaService, cache);
    let token = '',
      second = '',
      fresh = '';
    const adminToken = randomUUID();
    try {
      await cache.onModuleInit();
      await redis.connect();
      token = await sessions.issue(id);
      const initial = await redis.ttl(sessions.key(token));
      expect(initial).toBeGreaterThan(28790);
      const csrf = await Promise.all(
        Array.from({ length: 12 }, () => sessions.csrf(token)),
      );
      expect(new Set(csrf).size).toBe(1);
      expect(await redis.ttl(sessions.key(token, 'csrf'))).toBeLessThanOrEqual(
        initial,
      );
      await expect(
        sessions.validateCsrf(token, csrf[0]),
      ).resolves.toBeUndefined();
      await expect(sessions.validateCsrf(token, 'wrong')).rejects.toMatchObject(
        { status: 403 },
      );
      expect((await sessions.resolve(token)).emailVerifiedAt).toBeTruthy();
      expect(await redis.ttl(sessions.key(token))).toBeLessThanOrEqual(initial);
      await expect(admin.getAuthenticatedUser(token)).rejects.toMatchObject({
        status: 401,
      });
      await cache.set(
        sessions.key(adminToken),
        JSON.stringify({ realm: 'admin', userId: 'admin' }),
        60,
      );
      await expect(sessions.resolve(adminToken)).rejects.toMatchObject({
        status: 401,
      });
      second = await sessions.issue(id, 0);
      db.customerAccount.findUnique.mockResolvedValue({
        id,
        active: true,
        email: 'session@example.test',
        name: 'Session test',
        emailVerifiedAt: new Date(),
        authVersion: 1,
      });
      for (const old of [token, second])
        await expect(sessions.resolve(old)).rejects.toMatchObject({
          status: 401,
        });
      await expect(sessions.issue(id, 0)).rejects.toMatchObject({
        status: 401,
      });
      fresh = await sessions.issue(id, 1);
      await expect(sessions.resolve(fresh)).resolves.toMatchObject({
        customerId: id,
      });
      await sessions.revoke(token);
      expect(await cache.get(sessions.key(token, 'csrf'))).toBeNull();
      await expect(sessions.resolve(token)).rejects.toMatchObject({
        status: 401,
      });
      await expect(sessions.csrf(token)).rejects.toMatchObject({ status: 401 });
    } finally {
      if (token) await sessions.revoke(token);
      if (second) await sessions.revoke(second);
      if (fresh) await sessions.revoke(fresh);
      await cache.del(sessions.key(adminToken));
      await cache.onModuleDestroy();
      if (redis.isOpen) await redis.quit();
      if (previous === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previous;
    }
  }, 30000);
});
