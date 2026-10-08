import {
  Controller,
  Get,
  Post,
  Body,
  INestApplication,
  BadRequestException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { configureHttpSecurity } from './http-security';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { MediaController } from '../media/media.controller';
import { MediaService } from '../media/media.service';
import { ADMIN_SESSION_COOKIE, CSRF_COOKIE } from '../auth/auth.constants';
import { HealthController } from '../health/health.controller';

@Controller('probe')
class ProbeController {
  @Post() body(@Body() value: unknown) {
    return value;
  }
  @Get('error') error() {
    throw new Error('secret-dsn password /private/path stack');
  }
}

describe('Security HTTP contract (isolated dependency fixtures)', () => {
  it('enforces headers, parsers, origins, sessions, CSRF, roles, logout and readiness', async () => {
    const previous = { ...process.env };
    process.env.FRONTEND_URL = 'https://frontend.example';
    process.env.TRUST_PROXY = '127.0.0.1/32';
    const values = new Map<string, string>();
    const cache = {
      get: jest.fn(async (key: string) => values.get(key) || null),
      set: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      del: jest.fn(async (key: string) => {
        values.delete(key);
      }),
      getOrCreateSessionToken: jest.fn(
        async (_session: string, key: string, candidate: string) => {
          if (!values.has(key)) values.set(key, candidate);
          return values.get(key);
        },
      ),
      incrementWithExpiry: jest.fn().mockResolvedValue(1),
      ping: jest.fn().mockResolvedValue('PONG'),
    };
    const user = {
      id: 'fixture-user',
      email: 'fixture@example.test',
      name: null,
      role: UserRole.ADMIN as UserRole,
      active: true,
      passwordHash: 'fixture',
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([1]),
    };
    const admin = {
      listPages: jest.fn().mockResolvedValue([]),
      createSection: jest.fn().mockResolvedValue({}),
      saveSolutionDetail: jest
        .fn()
        .mockRejectedValue(new BadRequestException('Invalid content')),
    };
    const module = await Test.createTestingModule({
      controllers: [
        AuthController,
        AdminController,
        MediaController,
        ProbeController,
        HealthController,
      ],
      providers: [
        AuthService,
        { provide: CacheService, useValue: cache },
        { provide: PrismaService, useValue: prisma },
        { provide: AdminService, useValue: admin },
        {
          provide: MediaService,
          useValue: {
            createUploadSignature: jest
              .fn()
              .mockReturnValue({ signature: 'fixture' }),
          },
        },
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });
    const drain = configureHttpSecurity(app);
    jest
      .spyOn(module.get(AuthService), 'verifyPassword')
      .mockResolvedValue(true);
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const request = (
        route: string,
        options: Parameters<typeof globalThis.fetch>[1] = {},
      ) => globalThis.fetch(`${base}/api/${route}`, options);
      const login = (origin = 'https://frontend.example') =>
        request('auth/login', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: user.email,
            password: 'fixture-password',
          }),
        });
      expect((await login('https://evil.example')).status).toBe(403);
      expect((await request('admin/pages')).status).toBe(401);
      expect(
        (
          await request('admin/pages', {
            headers: { Cookie: `${ADMIN_SESSION_COOKIE}=malformed` },
          })
        ).status,
      ).toBe(401);
      const preflight = await request('auth/login', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://frontend.example',
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        'https://frontend.example',
      );
      const rejectedPreflight = await request('auth/login', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(
        rejectedPreflight.headers.get('access-control-allow-origin'),
      ).not.toBe('https://evil.example');
      const signedIn = await login();
      expect(signedIn.status).toBe(200);
      expect(signedIn.headers.get('cache-control')).toBe('no-store');
      const sessionCookie = signedIn.headers.getSetCookie()[0].split(';')[0];
      expect(signedIn.headers.getSetCookie()[0]).toContain('HttpOnly');
      const csrfResponse = await request('auth/csrf', {
        headers: { Cookie: sessionCookie },
      });
      const { csrfToken } = (await csrfResponse.json()) as {
        csrfToken: string;
      };
      const headers = {
        Origin: 'https://frontend.example',
        Cookie: `${sessionCookie}; ${CSRF_COOKIE}=${csrfToken}`,
        'x-csrf-token': csrfToken,
        'Content-Type': 'application/json',
      };
      expect(
        (
          await request('admin/media/upload-signature', {
            method: 'POST',
            headers: { Cookie: sessionCookie },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request('admin/media/upload-signature', {
            method: 'POST',
            headers: { ...headers, 'x-csrf-token': 'wrong' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request('admin/media/upload-signature', {
            method: 'POST',
            headers: { ...headers, Origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request('admin/media/upload-signature', {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(201);
      cache.incrementWithExpiry.mockResolvedValueOnce(21);
      expect(
        (
          await request('admin/media/upload-signature', {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(429);
      cache.incrementWithExpiry.mockResolvedValueOnce(21);
      const alternateMedia = await request('ADMIN/MEDIA/UPLOAD-SIGNATURE/', {
        method: 'POST',
        headers,
      });
      expect(alternateMedia.status).toBe(429);
      expect(alternateMedia.headers.get('cache-control')).toBe('no-store');
      cache.incrementWithExpiry.mockResolvedValueOnce(121);
      expect((await request('AUTH/CSRF/', { headers })).status).toBe(429);
      user.role = UserRole.EDITOR as typeof user.role;
      expect((await request('admin/pages', { headers })).status).toBe(200);
      expect(
        (
          await request('admin/pages/page/sections', {
            method: 'POST',
            headers,
            body: '{}',
          })
        ).status,
      ).toBe(403);
      user.role = UserRole.ADMIN;
      expect(
        (
          await request('admin/solutions/fixture', {
            method: 'PUT',
            headers,
            body: '{}',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request('probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }),
          })
        ).status,
      ).toBe(413);
      const error = await request('probe/error');
      expect(error.status).toBe(500);
      expect(await error.text()).not.toMatch(/secret|password|private|stack/);
      expect(error.headers.get('content-security-policy')).toContain(
        "frame-ancestors 'none'",
      );
      expect(error.headers.get('x-content-type-options')).toBe('nosniff');
      expect(error.headers.get('permissions-policy')).toBeTruthy();
      expect((await request('health/ready')).status).toBe(200);
      prisma.$queryRaw.mockRejectedValueOnce(
        new Error('private database secret'),
      );
      const dbFailure = await request('health/ready');
      expect(dbFailure.status).toBe(503);
      expect(await dbFailure.text()).not.toContain('private database secret');
      cache.ping.mockRejectedValueOnce(new Error('private redis secret'));
      expect((await request('health/ready')).status).toBe(503);
      expect((await request('health/live')).status).toBe(200);
      cache.get.mockRejectedValueOnce(new Error('private redis secret'));
      expect((await request('admin/pages', { headers })).status).toBe(500);
      expect(
        (await request('auth/logout', { method: 'POST', headers })).status,
      ).toBe(200);
      expect((await request('auth/me', { headers })).status).toBe(401);
      drain();
      expect((await request('health/ready')).status).toBe(503);
      expect((await request('health/live')).status).toBe(200);
    } finally {
      await app.close();
      process.env = previous;
    }
  }, 15000);
});
