import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const cache = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    getOrCreateSessionToken: jest.fn(),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('creates an opaque Redis session and returns safe user data', async () => {
    const service = new AuthService(prisma as never, cache as never);
    const hash = await service.hashPassword('a secure password');
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: UserRole.ADMIN,
      active: true,
      passwordHash: hash,
    });
    prisma.user.update.mockResolvedValue({});

    const result = await service.login(
      ' Admin@Example.com ',
      'a secure password',
    );

    expect(result.user).toEqual({
      id: 'user-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: UserRole.ADMIN,
    });
    expect(JSON.stringify(result)).not.toContain(hash);
    expect(result.token).toHaveLength(43);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:session:[a-f0-9]{64}$/),
      expect.stringContaining('"userId":"user-1"'),
      28_800,
    );
  });

  it('uses the same unauthorized response for unknown and invalid credentials', async () => {
    const service = new AuthService(prisma as never, cache as never);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      service.login('missing@example.com', 'wrong password'),
    ).rejects.toThrow('Invalid email or password');
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'admin@example.com',
      name: null,
      role: UserRole.ADMIN,
      active: false,
      passwordHash: await service.hashPassword('correct password'),
    });
    await expect(
      service.login('admin@example.com', 'correct password'),
    ).rejects.toThrow('Invalid email or password');
  });

  it('fails closed when Redis session storage is unavailable', async () => {
    const service = new AuthService(prisma as never, cache as never);
    cache.get.mockRejectedValue(new Error('Redis down'));
    await expect(service.getAuthenticatedUser('token')).rejects.toThrow(
      'Authentication service unavailable',
    );
    await expect(service.getAuthenticatedUser('token')).rejects.toMatchObject({
      status: 500,
    });
  });
  it('rejects expired/malformed sessions and rechecks the current role without sliding TTL', async () => {
    const service = new AuthService(prisma as never, cache as never);
    cache.get.mockResolvedValueOnce(null).mockResolvedValueOnce('{invalid');
    await expect(service.getAuthenticatedUser('fixture')).rejects.toMatchObject(
      { status: 401 },
    );
    await expect(service.getAuthenticatedUser('fixture')).rejects.toMatchObject(
      { status: 401 },
    );
    cache.get.mockResolvedValue(
      JSON.stringify({
        userId: 'fixture-user',
        role: 'ADMIN',
        createdAt: 'fixture',
        lastSeenAt: 'fixture',
      }),
    );
    prisma.user.findUnique.mockResolvedValue({
      id: 'fixture-user',
      email: 'fixture@example.test',
      name: null,
      role: UserRole.EDITOR,
      active: true,
    });
    expect((await service.getAuthenticatedUser('fixture')).role).toBe(
      UserRole.EDITOR,
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns the existing session-scoped CSRF token without overwriting it', async () => {
    const service = new AuthService(prisma as never, cache as never);
    cache.getOrCreateSessionToken.mockResolvedValue('existing-token');
    expect(await service.createCsrfToken('session')).toBe('existing-token');
    expect(cache.getOrCreateSessionToken).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:session:/),
      expect.stringMatching(/^auth:csrf:/),
      expect.any(String),
    );
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('returns 401 if the session expires during CSRF acquisition', async () => {
    const service = new AuthService(prisma as never, cache as never);
    cache.getOrCreateSessionToken.mockResolvedValue(null);
    await expect(service.createCsrfToken('session')).rejects.toMatchObject({
      status: 401,
    });
  });

  it.each([null, 'different-token', 'é'.repeat(43)])(
    'returns 403 for invalid CSRF without deleting the session (%s)',
    async (expected) => {
      const service = new AuthService(prisma as never, cache as never);
      cache.get.mockResolvedValue(expected);
      await expect(
        service.validateCsrfToken('session', 'x'.repeat(43)),
      ).rejects.toMatchObject({ status: 403 });
      expect(cache.del).not.toHaveBeenCalled();
    },
  );

  it('fails closed with 500, not 401, when CSRF storage is unavailable', async () => {
    const service = new AuthService(prisma as never, cache as never);
    cache.get.mockRejectedValue(new Error('Redis down'));
    cache.getOrCreateSessionToken.mockRejectedValue(new Error('Redis down'));
    await expect(service.createCsrfToken('session')).rejects.toMatchObject({
      status: 500,
    });
    await expect(
      service.validateCsrfToken('session', 'csrf'),
    ).rejects.toMatchObject({ status: 500 });
    expect(cache.del).not.toHaveBeenCalled();
  });
});
