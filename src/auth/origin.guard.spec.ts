import { ExecutionContext } from '@nestjs/common';
import { OriginGuard } from './origin.guard';

describe('OriginGuard', () => {
  const context = (origin?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { origin } }) }),
    }) as never as ExecutionContext;

  it('accepts only the configured exact origin', () => {
    const previous = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'http://localhost:5173';
    const guard = new OriginGuard();

    expect(guard.canActivate(context('http://localhost:5173'))).toBe(true);
    expect(() => guard.canActivate(context('https://evil.example'))).toThrow(
      'Unexpected request origin',
    );
    expect(() => guard.canActivate(context())).toThrow(
      'Unexpected request origin',
    );
    process.env.FRONTEND_URL = previous;
  });
});
