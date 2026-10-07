import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionAuthGuard } from './session-auth.guard';
import { CsrfGuard } from './csrf.guard';
import { OriginGuard } from './origin.guard';
import { RolesGuard } from './roles.guard';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { ADMIN_SESSION_COOKIE, CSRF_COOKIE } from './auth.constants';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { CacheService } from '../cache/cache.service';
import { PageCacheInvalidationService } from '../cache/page-cache-invalidation.service';
import { PrismaService } from '../prisma/prisma.service';
const fetch = globalThis.fetch;

// Opt in against local Redis. Randomized keys are cleaned up; no real users or
// PostgreSQL records are read or changed.
const redisDescribe = process.env.AUTH_REDIS_TEST_URL
  ? describe
  : describe.skip;

redisDescribe('Admin session HTTP regression with real Redis', () => {
  it('preserves the session across concurrent CSRF requests, saves and navigation', async () => {
    const oldRedisUrl = process.env.REDIS_URL;
    const oldOrigin = process.env.FRONTEND_URL;
    process.env.REDIS_URL = process.env.AUTH_REDIS_TEST_URL;
    process.env.FRONTEND_URL = 'http://localhost:5173';
    const slug = `auth-regression-${randomUUID()}`;
    const user = {
      id: randomUUID(),
      email: 'test@example.com',
      name: null,
      role: UserRole.ADMIN,
      active: true,
      passwordHash: '',
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn(),
      },
      page: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: slug, slug, sections: [] }),
      },
      pageSection: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ type: 'solutionOverview', page: { slug } }),
      },
      pageSectionTranslation: {
        upsert: jest.fn().mockResolvedValue({ content: {} }),
      },
    };
    let app: INestApplication | undefined;
    let cache: CacheService | undefined;
    let auth: AuthService | undefined;
    let session = '';
    const redis = createClient({ url: process.env.AUTH_REDIS_TEST_URL });
    try {
      const module = await Test.createTestingModule({
        controllers: [AuthController, AdminController],
        providers: [
          AuthService,
          AdminService,
          CacheService,
          PageCacheInvalidationService,
          SessionAuthGuard,
          CsrfGuard,
          OriginGuard,
          RolesGuard,
          { provide: PrismaService, useValue: prisma },
          LoginRateLimitGuard,
        ],
      })
        .overrideGuard(LoginRateLimitGuard)
        .useValue({ canActivate: () => true })
        .compile();
      auth = module.get<AuthService>(AuthService);
      cache = module.get<CacheService>(CacheService);
      user.passwordHash = await auth.hashPassword('regression password');
      app = module.createNestApplication();
      app.setGlobalPrefix('api');
      app.use(cookieParser());
      await app.listen(0, '127.0.0.1');
      await redis.connect();
      const url = `${await app.getUrl()}/api`;
      const login = await fetch(`${url}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          password: 'regression password',
        }),
      });
      expect(login.status).toBe(200);
      const sessionCookie = login.headers.getSetCookie()[0].split(';')[0];
      session = sessionCookie.slice(sessionCookie.indexOf('=') + 1);
      expect(sessionCookie.startsWith(`${ADMIN_SESSION_COOKIE}=`)).toBe(true);
      expect(login.headers.getSetCookie()[0]).toContain('HttpOnly');
      expect(login.headers.getSetCookie()[0]).toContain('Path=/');
      expect(login.headers.getSetCookie()[0]).toContain('SameSite=Lax');
      const digest = createHash('sha256').update(session).digest('hex');
      const sessionKey = `auth:session:${digest}`;
      const csrfKey = `auth:csrf:${digest}`;
      const serializedSession = await cache.get(sessionKey);
      expect(serializedSession).not.toBeNull();
      const initialTtl = await redis.ttl(sessionKey);
      expect(initialTtl).toBeGreaterThan(28_790);
      expect(initialTtl).toBeLessThanOrEqual(28_800);
      const me = () =>
        fetch(`${url}/auth/me`, { headers: { Cookie: sessionCookie } });
      expect((await me()).status).toBe(200);
      const acquisitions = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const response = await fetch(`${url}/auth/csrf`, {
            headers: { Cookie: sessionCookie },
          });
          expect(response.status).toBe(200);
          const body = (await response.json()) as { csrfToken: string };
          expect(response.headers.getSetCookie()[0]).toContain(
            `${CSRF_COOKIE}=${body.csrfToken}`,
          );
          return body.csrfToken;
        }),
      );
      expect(new Set(acquisitions).size).toBe(1);
      const csrf = acquisitions[0];
      expect(await cache.get(csrfKey)).toBe(csrf);
      expect(await redis.ttl(csrfKey)).toBeLessThanOrEqual(
        await redis.ttl(sessionKey),
      );
      const save = (token = csrf, content: unknown = {}) =>
        fetch(`${url}/admin/sections/test/translations/vi`, {
          method: 'PUT',
          headers: {
            Cookie: `${sessionCookie}; ${CSRF_COOKIE}=${token}`,
            'x-csrf-token': token,
            'Content-Type': 'application/json',
            Origin: 'http://localhost:5173',
          },
          body: JSON.stringify({ content }),
        });
      for (let index = 0; index < 3; index++) {
        await cache.set(`cms:page:${slug}:vi`, 'cached', 60);
        await cache.set(`cms:page:${slug}:en`, 'untouched', 60);
        expect((await save()).status).toBe(200);
        expect(await cache.get(`cms:page:${slug}:vi`)).toBeNull();
        expect(await cache.get(`cms:page:${slug}:en`)).toBe('untouched');
        expect(await cache.get(sessionKey)).toBe(serializedSession);
        const ttl = await redis.ttl(sessionKey);
        expect(ttl).toBeLessThanOrEqual(initialTtl);
        expect(ttl).toBeGreaterThan(initialTtl - 30);
        expect(await cache.get(csrfKey)).toBe(csrf);
        expect((await me()).status).toBe(200);
        expect(
          (
            await fetch(`${url}/admin/pages/${slug}`, {
              headers: { Cookie: sessionCookie },
            })
          ).status,
        ).toBe(200);
      }
      expect((await save('invalid')).status).toBe(403);
      expect((await save(csrf, null)).status).toBe(400);
      expect((await me()).status).toBe(200);
      expect((await save()).status).toBe(200);
      expect(prisma.pageSectionTranslation.upsert).toHaveBeenCalledTimes(4);
      await cache.del(sessionKey);
      expect((await me()).status).toBe(401);
      expect((await save()).status).toBe(401);
    } finally {
      if (session && auth) await auth.revoke(session);
      if (cache) {
        await cache.del(`cms:page:${slug}:vi`);
        await cache.del(`cms:page:${slug}:en`);
      }
      if (app) await app.close();
      if (redis.isOpen) await redis.quit();
      if (oldRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = oldRedisUrl;
      if (oldOrigin === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = oldOrigin;
    }
  }, 30_000);
});
