import { randomBytes } from 'node:crypto';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerSessionService } from './customer-session.service';
import { customerCookieOptions } from './customer.controller';

describe('Customer session security', () => {
  const db = { customerAccount: { findUnique: jest.fn() } };
  const cache = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    getOrCreateSessionToken: jest.fn(),
    incrementWithExpiry: jest.fn(),
  };
  let service: CustomerSessionService;
  beforeEach(() => {
    jest.resetAllMocks();
    db.customerAccount.findUnique.mockResolvedValue({
      active: true,
      authVersion: 0,
    });
    service = new CustomerSessionService(
      cache as unknown as CacheService,
      db as unknown as PrismaService,
    );
  });
  it('issues opaque sessions with a fixed TTL in an independent namespace', async () => {
    const token = await service.issue('customer');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cache.set).toHaveBeenCalledWith(
      service.key(token),
      JSON.stringify({
        realm: 'customer',
        customerId: 'customer',
        authVersion: 0,
      }),
      28800,
    );
    expect(service.key(token)).not.toContain(token);
    expect(service.key(token)).toMatch(/^customer:session:/);
  });
  it('restores current verified state from the customer table, without sliding expiry', async () => {
    cache.get.mockResolvedValue(
      JSON.stringify({ realm: 'customer', customerId: 'customer' }),
    );
    db.customerAccount.findUnique.mockResolvedValue({
      id: 'customer',
      active: true,
      email: 'a@example.test',
      name: 'A',
      emailVerifiedAt: new Date(),
    });
    expect(
      await service.resolve(randomBytes(32).toString('base64url')),
    ).toMatchObject({ realm: 'customer', customerId: 'customer' });
    expect(cache.set).not.toHaveBeenCalled();
  });
  it('rejects malformed, missing and CMS-realm sessions', async () => {
    await expect(service.resolve('bad')).rejects.toThrow();
    cache.get.mockResolvedValue(null);
    await expect(
      service.resolve(randomBytes(32).toString('base64url')),
    ).rejects.toThrow();
    cache.get.mockResolvedValue(
      JSON.stringify({ userId: 'admin', realm: 'admin' }),
    );
    await expect(
      service.resolve(randomBytes(32).toString('base64url')),
    ).rejects.toThrow();
    expect(db.customerAccount.findUnique).not.toHaveBeenCalled();
  });
  it('invalidates every old session generation and rejects a stale login racing reset', async () => {
    cache.get.mockResolvedValue(
      JSON.stringify({
        realm: 'customer',
        customerId: 'customer',
        authVersion: 0,
      }),
    );
    db.customerAccount.findUnique.mockResolvedValue({
      active: true,
      authVersion: 1,
    });
    await expect(
      service.resolve(randomBytes(32).toString('base64url')),
    ).rejects.toMatchObject({ status: 401 });
    await expect(service.issue('customer', 0)).rejects.toMatchObject({
      status: 401,
    });
    expect(cache.set).not.toHaveBeenCalled();
  });
  it('rejects inactive accounts and fails closed when Redis is unavailable', async () => {
    cache.get.mockResolvedValue(
      JSON.stringify({ realm: 'customer', customerId: 'customer' }),
    );
    db.customerAccount.findUnique.mockResolvedValue({ active: false });
    await expect(
      service.resolve(randomBytes(32).toString('base64url')),
    ).rejects.toThrow();
    cache.get.mockRejectedValue(new Error('private credentials'));
    await expect(
      service.resolve(randomBytes(32).toString('base64url')),
    ).rejects.toThrow('Customer service unavailable');
  });
  it('atomically reuses session-bound CSRF and rejects missing/wrong values', async () => {
    cache.getOrCreateSessionToken.mockResolvedValue('csrf-value');
    expect(await service.csrf('session')).toBe('csrf-value');
    cache.get.mockResolvedValue('csrf-value');
    await expect(service.validateCsrf('session', undefined)).rejects.toThrow(
      'Invalid CSRF',
    );
    await expect(service.validateCsrf('session', 'bad')).rejects.toThrow(
      'Invalid CSRF',
    );
    await expect(
      service.validateCsrf('session', 'csrf-value'),
    ).resolves.toBeUndefined();
  });
  it('revokes session and CSRF; rate limits and store failure are safe', async () => {
    await service.revoke('token');
    expect(cache.del.mock.calls).toEqual([
      [service.key('token')],
      [service.key('token', 'csrf')],
    ]);
    cache.incrementWithExpiry.mockResolvedValue(61);
    await expect(service.rate('customer', 'mutation')).rejects.toMatchObject({
      status: 429,
    });
    cache.del.mockRejectedValue(new Error('private store error'));
    await expect(service.revoke('token')).rejects.toThrow(
      'Customer service unavailable',
    );
  });
  it('uses HttpOnly, Lax, host-only cookies and enforces Secure in production', () => {
    const oldMode = process.env.NODE_ENV,
      oldOrigin = process.env.FRONTEND_URL;
    try {
      process.env.NODE_ENV = 'development';
      process.env.FRONTEND_URL = 'http://localhost:5173';
      expect(customerCookieOptions()).toMatchObject({
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
      });
      expect(customerCookieOptions()).not.toHaveProperty('domain');
      process.env.NODE_ENV = 'production';
      expect(customerCookieOptions().secure).toBe(true);
    } finally {
      process.env.NODE_ENV = oldMode;
      process.env.FRONTEND_URL = oldOrigin;
    }
  });
});
