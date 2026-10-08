import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ADMIN_SESSION_COOKIE } from './auth.constants';

describe('AuthController', () => {
  it('uses non-secure cookies only for local HTTP development and clears matching options', async () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = 'development';
    process.env.FRONTEND_URL = 'http://localhost:5173';
    const service = {
      login: jest.fn().mockResolvedValue({ user: {}, token: 'fixture' }),
      revoke: jest.fn(),
    };
    const controller = new AuthController(service as never);
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    try {
      await controller.login(
        { email: 'fixture@example.test', password: 'fixture-password' },
        response as never,
      );
      expect(response.cookie).toHaveBeenLastCalledWith(
        expect.any(String),
        'fixture',
        expect.objectContaining({
          secure: false,
          httpOnly: true,
          path: '/',
          maxAge: 28800000,
        }),
      );
      process.env.FRONTEND_URL = 'https://frontend.example';
      await controller.login(
        { email: 'fixture@example.test', password: 'fixture-password' },
        response as never,
      );
      expect(response.cookie).toHaveBeenLastCalledWith(
        expect.any(String),
        'fixture',
        expect.objectContaining({ secure: true }),
      );
      process.env.NODE_ENV = 'production';
      await controller.logout(
        { cookies: { [ADMIN_SESSION_COOKIE]: 'fixture' } },
        response as never,
      );
      expect(service.revoke).toHaveBeenCalledWith('fixture');
      expect(response.clearCookie).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        }),
      );
      expect(response.clearCookie).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
          path: '/',
        }),
      );
    } finally {
      process.env = previous;
    }
  });
  it('sets an HttpOnly secure cookie in production without returning the token', async () => {
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const service = {
      login: jest.fn().mockResolvedValue({
        user: {
          id: 'user-1',
          email: 'admin@example.com',
          name: null,
          role: 'ADMIN',
        },
        token: 'opaque-session-token',
      }),
    } as unknown as AuthService;
    const response = { cookie: jest.fn() };
    const controller = new AuthController(service);

    const result = await controller.login(
      { email: 'admin@example.com', password: 'a secure password' },
      response as never,
    );

    expect(result).toEqual({
      user: {
        id: 'user-1',
        email: 'admin@example.com',
        name: null,
        role: 'ADMIN',
      },
    });
    expect(JSON.stringify(result)).not.toContain('opaque-session-token');
    expect(response.cookie).toHaveBeenCalledWith(
      expect.any(String),
      'opaque-session-token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 28_800_000,
      }),
    );
    process.env.NODE_ENV = previousEnvironment;
  });
});
