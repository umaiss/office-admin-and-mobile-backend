import type { Request } from 'express';

import { Role } from '../../generated/prisma/enums';

/**
 * What `JwtStrategy.validate()` returns, and therefore what Passport attaches
 * to `request.user` on every authenticated request.
 *
 * Defining this shape once, in one file, is what lets guards, decorators, and
 * controllers read `request.user` with real types instead of `any`. Without it,
 * `user.role` is an untyped property access — a typo like `user.roles` compiles
 * fine and silently evaluates to `undefined`, which in a security check means
 * the check quietly passes or quietly fails. Types are a security control here,
 * not a style preference.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: Role;
}

/** An Express request that has passed through `JwtAuthGuard`. */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}
