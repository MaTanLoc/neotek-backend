import { randomBytes } from 'node:crypto';
import { CustomerService } from './customer.service';
import { VerificationSecret } from '../notification/verification-secret';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

describe('Customer identity foundation security', () => {
  const cache = { incrementWithExpiry: jest.fn() };
  const db = { customerAccount: { findUnique: jest.fn() } };
  const secrets = new VerificationSecret(randomBytes(32).toString('base64'));
  const service = new CustomerService(
    db as unknown as PrismaService,
    new NotificationService(),
    cache as unknown as CacheService,
    secrets,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    cache.incrementWithExpiry.mockResolvedValue(1);
  });
  it('rate limits registration/login and fails closed if Redis is unavailable', async () => {
    cache.incrementWithExpiry.mockResolvedValue(6);
    await expect(service.register({}, 'ip')).rejects.toMatchObject({
      status: 429,
    });
    await expect(service.authenticate({}, 'ip')).rejects.toMatchObject({
      status: 429,
    });
    cache.incrementWithExpiry.mockRejectedValue(
      new Error('private Redis connection'),
    );
    await expect(service.authenticate({}, 'ip')).rejects.toThrow(
      'Customer service unavailable',
    );
    expect(db.customerAccount.findUnique).not.toHaveBeenCalled();
  });
  it('limits verification attempts and rejects raw malformed tokens without database lookup', async () => {
    await expect(service.verify('bad', 'ip')).rejects.toThrow(
      'Invalid verification token',
    );
    cache.incrementWithExpiry.mockResolvedValue(21);
    await expect(service.verify('x'.repeat(43), 'ip')).rejects.toMatchObject({
      status: 429,
    });
    expect(cache.incrementWithExpiry.mock.calls[0][0]).toMatch(
      /^customer:ratelimit:verify-ip:[a-f0-9]{64}$/,
    );
  });
  it('encrypts durable verification tokens with authenticated context and rejects tampering', () => {
    const raw = randomBytes(32).toString('base64url');
    const sealed = secrets.seal(raw, 'verification-id');
    expect(sealed).not.toContain(raw);
    expect(secrets.open(sealed, 'verification-id')).toBe(raw);
    expect(() => secrets.open(sealed, 'other-id')).toThrow();
    expect(() => new VerificationSecret('short-key')).toThrow();
  });
});
