import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Role } from '../generated/prisma/enums';
import { RolesGuard } from './roles.guard';
import type { AuthenticatedUser } from './types/authenticated-request';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  /**
   * Builds the smallest ExecutionContext the guard actually touches.
   *
   * A real ExecutionContext has ~10 methods; stubbing all of them would be
   * noise. We provide the three the guard calls and cast once, at the boundary,
   * with a comment — rather than sprinkling `any` through the test body.
   */
  function createMockContext(user?: AuthenticatedUser): ExecutionContext {
    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  const admin: AuthenticatedUser = {
    userId: 'u1',
    email: 'admin@example.com',
    role: Role.ADMIN,
  };

  const officeBoy: AuthenticatedUser = {
    userId: 'u2',
    email: 'ob@example.com',
    role: Role.OFFICE_BOY,
  };

  it('allows access when the route declares no required roles', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(createMockContext(officeBoy))).toBe(true);
  });

  it('allows access when the user has a required role', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    expect(guard.canActivate(createMockContext(admin))).toBe(true);
  });

  it('denies access when the user lacks the required role', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    expect(guard.canActivate(createMockContext(officeBoy))).toBe(false);
  });

  it('denies access when no user is attached to the request', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);

    // This is the fail-closed case: if authentication somehow did not run,
    // authorisation must refuse rather than fall through to allow.
    expect(guard.canActivate(createMockContext(undefined))).toBe(false);
  });
});
