import { ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

describe('CsrfGuard', () => {
  const context = (request: unknown) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as never as ExecutionContext;

  it('requires matching cookie and header tokens', async () => {
    const auth = { validateCsrfToken: jest.fn() };
    const guard = new CsrfGuard(auth as never);
    const request = {
      cookies: { neotek_admin_session: 'session', neotek_admin_csrf: 'csrf' },
      headers: { 'x-csrf-token': 'csrf' },
    };

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(auth.validateCsrfToken).toHaveBeenCalledWith('session', 'csrf');
  });

  it('rejects missing or invalid CSRF tokens', async () => {
    const auth = { validateCsrfToken: jest.fn() };
    const guard = new CsrfGuard(auth as never);
    const request = {
      cookies: { neotek_admin_session: 'session', neotek_admin_csrf: 'csrf' },
      headers: { 'x-csrf-token': 'wrong' },
    };

    await expect(guard.canActivate(context(request))).rejects.toMatchObject({
      status: 401,
    });
    auth.validateCsrfToken.mockRejectedValue(new Error('invalid'));
    await expect(
      guard.canActivate(
        context({
          cookies: {
            neotek_admin_session: 'session',
            neotek_admin_csrf: 'csrf',
          },
          headers: { 'x-csrf-token': 'csrf' },
        }),
      ),
    ).rejects.toThrow('invalid');
  });
});
