import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  function context(role: UserRole): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as never;
  }

  it('allows ADMIN and rejects EDITOR for ADMIN-only metadata', () => {
    const reflector = new Reflector();
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([UserRole.ADMIN]);
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(context(UserRole.ADMIN))).toBe(true);
    expect(() => guard.canActivate(context(UserRole.EDITOR))).toThrow(
      'Insufficient role',
    );
  });
});
