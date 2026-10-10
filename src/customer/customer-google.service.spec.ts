import { CustomerGoogleService } from './customer-google.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { GoogleTokenVerifier } from './google-token-verifier';
import { Prisma } from '@prisma/client';

describe('Google customer request boundary', () => {
  const db = { $transaction: jest.fn() },
    cache = { incrementWithExpiry: jest.fn() },
    verifier = { verify: jest.fn() };
  const service = new CustomerGoogleService(
    db as unknown as PrismaService,
    cache as unknown as CacheService,
    verifier as unknown as GoogleTokenVerifier,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    cache.incrementWithExpiry.mockResolvedValue(1);
  });
  it('rejects strict/oversized/malformed input before token verification or database access', async () => {
    for (const body of [
      {},
      { credential: 'bad' },
      { credential: 'a'.repeat(8193) },
      { credential: 'aaaaaaa.bbbbbbb.ccccccc', email: 'forged@gmail.com' },
      { credential: 123 },
    ])
      await expect(
        service.authenticate(body, 'private-ip'),
      ).rejects.toMatchObject({ status: 400 });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rate limits and fails Redis closed before expensive Google work, without storing IPs or credentials', async () => {
    cache.incrementWithExpiry.mockResolvedValue(11);
    await expect(service.authenticate({}, 'private-ip')).rejects.toMatchObject({
      status: 429,
    });
    expect(cache.incrementWithExpiry.mock.calls[0][0]).toMatch(
      /^customer:ratelimit:google-ip:[a-f0-9]{64}$/,
    );
    cache.incrementWithExpiry.mockRejectedValue(
      new Error('redis-private-detail'),
    );
    await expect(service.authenticate({}, 'private-ip')).rejects.toMatchObject({
      status: 503,
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('retries a registration unique conflict, bounds retries and propagates unrelated failures', async () => {
    const flag = process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED,
      client = process.env.GOOGLE_CUSTOMER_CLIENT_ID;
    process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'true';
    process.env.GOOGLE_CUSTOMER_CLIENT_ID =
      'fixture.apps.googleusercontent.com';
    try {
      const conflict = new Prisma.PrismaClientKnownRequestError(
        'unique conflict',
        { code: 'P2002', clientVersion: 'test' },
      );
      verifier.verify.mockResolvedValue({
        subject: 'fixture',
        email: 'customer@gmail.com',
        authoritativeEmail: true,
        name: 'Customer',
      });
      db.$transaction
        .mockRejectedValueOnce(conflict)
        .mockResolvedValueOnce({ customerId: 'existing-customer' });
      expect(
        await service.authenticate(
          { credential: 'fixture.credential.signature' },
          'retry',
        ),
      ).toEqual({ customerId: 'existing-customer' });
      expect(db.$transaction).toHaveBeenCalledTimes(2);
      db.$transaction.mockReset().mockRejectedValue(conflict);
      await expect(
        service.authenticate(
          { credential: 'fixture.credential.signature' },
          'bounded',
        ),
      ).rejects.toBe(conflict);
      expect(db.$transaction).toHaveBeenCalledTimes(3);
      const unavailable = new Error('unavailable');
      db.$transaction.mockReset().mockRejectedValue(unavailable);
      await expect(
        service.authenticate(
          { credential: 'fixture.credential.signature' },
          'no-retry',
        ),
      ).rejects.toBe(unavailable);
      expect(db.$transaction).toHaveBeenCalledTimes(1);
    } finally {
      if (flag === undefined) delete process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED;
      else process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = flag;
      if (client === undefined) delete process.env.GOOGLE_CUSTOMER_CLIENT_ID;
      else process.env.GOOGLE_CUSTOMER_CLIENT_ID = client;
    }
  });
});
