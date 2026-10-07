import { Test } from '@nestjs/testing';
import * as cookieParser from 'cookie-parser';
import { AuthService } from '../auth/auth.service';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { OriginGuard } from '../auth/origin.guard';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { ADMIN_SESSION_COOKIE, CSRF_COOKIE } from '../auth/auth.constants';

describe('MediaController security', () => {
  it('requires session, matching CSRF and expected origin before signing', async () => {
    const previous = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'http://localhost:5173';
    const media = {
      createUploadSignature: jest.fn().mockReturnValue({ signature: 'signed' }),
    };
    const module = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        SessionAuthGuard,
        CsrfGuard,
        OriginGuard,
        { provide: MediaService, useValue: media },
        {
          provide: AuthService,
          useValue: {
            getAuthenticatedUser: jest
              .fn()
              .mockResolvedValue({ id: 'editor', role: 'EDITOR' }),
            validateCsrfToken: jest.fn(),
          },
        },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.use(cookieParser());
    try {
      await app.listen(0, '127.0.0.1');
      const url = `${await app.getUrl()}/admin/media/upload-signature`;
      const fetch = globalThis.fetch;
      const cookie = `${ADMIN_SESSION_COOKIE}=session; ${CSRF_COOKIE}=csrf`;
      expect((await fetch(url, { method: 'POST' })).status).toBe(401);
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: { Cookie: cookie, 'x-csrf-token': 'wrong' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(url, {
            method: 'POST',
            headers: {
              Cookie: cookie,
              'x-csrf-token': 'csrf',
              Origin: 'http://evil.example',
            },
          })
        ).status,
      ).toBe(403);
      expect(media.createUploadSignature).not.toHaveBeenCalled();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'x-csrf-token': 'csrf',
          Origin: 'http://localhost:5173',
        },
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ signature: 'signed' });
      expect(media.createUploadSignature).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previous;
    }
  });
});
