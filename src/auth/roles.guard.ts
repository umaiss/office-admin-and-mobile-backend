import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Role } from '../generated/prisma/enums';
import { ROLES_KEY } from './roles.decorator';
import type { AuthenticatedRequest } from './types/authenticated-request';

/**
 * Authorisation: decides whether an already-authenticated user is *allowed* to
 * call this route.
 *
 * Note the division of labour. `JwtAuthGuard` answers "who are you?"
 * (authentication). This guard answers "may you do this?" (authorisation).
 * They are separate guards because they are separate questions, and conflating
 * the two is one of the most common sources of access-control bugs.
 *
 * Ordering matters: this guard must run AFTER JwtAuthGuard, because it reads
 * `request.user` — which is exactly what JwtAuthGuard puts there. Nest runs
 * guards in the order listed: `@UseGuards(JwtAuthGuard, RolesGuard)`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // getAllAndOverride checks the handler first, then the controller, so a
    // method-level @Roles() can override a controller-level default.
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles() on the route means "any authenticated user may proceed".
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // Deny by default. No user here means the route was reached without
    // authentication running first — refusing is the only safe response.
    if (!user?.role) {
      return false;
    }

    return requiredRoles.includes(user.role);
  }
}
