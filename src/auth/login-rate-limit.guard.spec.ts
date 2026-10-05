import { ExecutionContext } from '@nestjs/common';
import { LoginRateLimitGuard } from './login-rate-limit.guard';

describe('LoginRateLimitGuard', () => {
  it('allows five attempts and rejects the sixth', async () => {
    const cache = { incrementWithExpiry: jest.fn() };
    cache.incrementWithExpiry
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(6);
    const guard = new LoginRateLimitGuard(cache as never);
    const context = (ip: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ ip }) }),
      }) as never as ExecutionContext;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(guard.canActivate(context('127.0.0.1'))).resolves.toBe(true);
    }
    await expect(guard.canActivate(context('127.0.0.1'))).rejects.toMatchObject(
      {
        status: 429,
      },
    );
    expect(cache.incrementWithExpiry).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:ratelimit:login:[a-f0-9]{64}$/),
      60,
    );
  });

  it('fails closed when Redis is unavailable', async () => {
    const cache = {
      incrementWithExpiry: jest.fn().mockRejectedValue(new Error('Redis down')),
    };
    const guard = new LoginRateLimitGuard(cache as never);
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ ip: '127.0.0.1' }) }),
    } as never as ExecutionContext;

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 503,
    });
  });
});
