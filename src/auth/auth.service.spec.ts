import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const cache = {
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
  };
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
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
  });
});
