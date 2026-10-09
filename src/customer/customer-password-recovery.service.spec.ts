import { randomBytes } from 'node:crypto';
import {
  CustomerPasswordRecoveryService,
  passwordResetMinutes,
} from './customer-password-recovery.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { NotificationService } from '../notification/notification.service';
import { VerificationSecret } from '../notification/verification-secret';

describe('Customer password recovery boundaries', () => {
  const cache = { incrementWithExpiry: jest.fn() },
    db = { $transaction: jest.fn() };
  const recovery = new CustomerPasswordRecoveryService(
    db as unknown as PrismaService,
    cache as unknown as CacheService,
    new NotificationService(),
    new VerificationSecret(randomBytes(32).toString('base64')),
  );
  beforeEach(() => {
    jest.resetAllMocks();
    cache.incrementWithExpiry.mockResolvedValue(1);
  });
  it('shares the registration policy and validates email, confirmation and strict fields before writes', async () => {
    for (const body of [
      { email: 'bad', locale: 'vi' },
      { email: 'a@example.test', locale: 'vi', role: 'ADMIN' },
    ])
      await expect(recovery.forgot(body, 'ip')).rejects.toMatchObject({
        status: 400,
      });
    for (const body of [
      { token: 'x'.repeat(43), password: 'short', confirmPassword: 'short' },
      {
        token: 'x'.repeat(43),
        password: 'a secure password',
        confirmPassword: 'another password',
      },
      {
        token: 'bad',
        password: 'a secure password',
        confirmPassword: 'a secure password',
      },
      {
        token: 'x'.repeat(43),
        password: 'a'.repeat(257),
        confirmPassword: 'a'.repeat(257),
      },
    ])
      await expect(recovery.reset(body, 'ip')).rejects.toMatchObject({
        status: 400,
      });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rate limits forgot and reset before expensive work and hashes identifiers', async () => {
    cache.incrementWithExpiry.mockResolvedValue(21);
    await expect(recovery.forgot({}, 'private-ip')).rejects.toMatchObject({
      status: 429,
    });
    await expect(recovery.reset({}, 'private-ip')).rejects.toMatchObject({
      status: 429,
    });
    expect(cache.incrementWithExpiry.mock.calls[0][0]).toMatch(
      /^customer:recovery:forgot-ip:[a-f0-9]{64}$/,
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('fails closed without leaking Redis errors', async () => {
    cache.incrementWithExpiry.mockRejectedValue(
      new Error('private connection credentials'),
    );
    await expect(recovery.forgot({}, 'ip')).rejects.toThrow(
      'Customer service unavailable',
    );
    await expect(recovery.reset({}, 'ip')).rejects.toMatchObject({
      status: 503,
    });
  });
  it('accepts only a bounded configurable lifetime', () => {
    expect(passwordResetMinutes({})).toBe(45);
    expect(
      passwordResetMinutes({ CUSTOMER_PASSWORD_RESET_MINUTES: '30' }),
    ).toBe(30);
    for (const value of ['0', '29', '61', 'NaN', '45.5'])
      expect(() =>
        passwordResetMinutes({ CUSTOMER_PASSWORD_RESET_MINUTES: value }),
      ).toThrow();
  });
});
