import { randomBytes } from 'node:crypto';
import { CustomerService } from './customer.service';
import { VerificationSecret } from '../notification/verification-secret';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

describe('Customer identity foundation security', () => {
  const cache = { incrementWithExpiry: jest.fn() };
  const tx = {
    customerAccount: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    customerEmailVerification: { updateMany: jest.fn(), create: jest.fn() },
    notificationDelivery: { updateMany: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const db = {
    customerAccount: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
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
    db.$transaction.mockImplementation(
      // eslint-disable-next-line no-unused-vars -- Type-only transaction callback.
      async (callback: (client: typeof tx) => Promise<void>) => callback(tx),
    );
    tx.customerAccount.create.mockResolvedValue({ id: 'customer-id' });
    tx.$queryRaw.mockResolvedValue([{ now: new Date() }]);
  });
  const registration = {
    email: 'customer@example.test',
    name: 'Customer',
    password: 'valid password 123',
    locale: 'vi',
  };
  it.each([
    undefined,
    '',
    '   ',
    'invalid',
    '12345',
    '0900\n000000',
    '1'.repeat(33),
  ])(
    'rejects missing or invalid registration phone %j before database work',
    async (phone) => {
      await expect(
        service.register({ ...registration, phone }, 'ip'),
      ).rejects.toMatchObject({ status: 400 });
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it('persists the validated and trimmed registration phone without creating a session', async () => {
    await expect(
      service.register({ ...registration, phone: ' +84 900 000 000 ' }, 'ip'),
    ).resolves.toEqual({ accepted: true });
    expect(tx.customerAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: registration.email,
        phone: '+84 900 000 000',
        name: registration.name,
        passwordHash: expect.any(String),
      }),
    });
    expect(tx.customerEmailVerification.create).toHaveBeenCalledTimes(1);
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
  it.each(['missing', 'inactive', 'verified', 'cooldown', 'unverified'])(
    'anonymous resend is enumeration-safe for %s accounts',
    async (kind) => {
      db.customerAccount.findUnique.mockResolvedValue(
        kind === 'missing' ? null : { id: 'customer-id' },
      );
      tx.customerAccount.findUnique.mockResolvedValue({
        id: 'customer-id',
        email: registration.email,
        active: kind !== 'inactive',
        emailVerifiedAt: kind === 'verified' ? new Date() : null,
        verificationIssuedAt: kind === 'cooldown' ? new Date() : null,
      });
      await expect(
        service.resendByEmail(
          { email: registration.email, locale: 'vi' },
          'ip',
        ),
      ).resolves.toEqual({ accepted: true });
      expect(tx.customerEmailVerification.create).toHaveBeenCalledTimes(
        kind === 'unverified' ? 1 : 0,
      );
      expect(cache.incrementWithExpiry.mock.calls[0][0]).toMatch(
        /^customer:ratelimit:resend-ip:/,
      );
      expect(cache.incrementWithExpiry.mock.calls[1][0]).toMatch(
        /^customer:ratelimit:resend-email:/,
      );
    },
  );
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
