import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
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
