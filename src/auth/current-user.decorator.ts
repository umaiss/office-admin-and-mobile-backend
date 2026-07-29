import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from './types/authenticated-request';

/**
 * Pulls the authenticated user (or one of its fields) out of the request.
 *
 *   @Get('profile')
 *   getProfile(@CurrentUser('userId') userId: string) { ... }
 *   getWhole(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * A custom parameter decorator exists so that controllers never touch the raw
 * `request` object. That keeps them free of HTTP plumbing and, more usefully,
 * keeps the identity of the caller coming from the verified token rather than
 * from anything the caller could set themselves — such as a `userId` in the
 * body or query string. Trusting a client-supplied user id is one of the
 * classic ways APIs end up letting one user read another user's data.
 *
 * Typing `data` as `keyof AuthenticatedUser` means a typo like
 * `@CurrentUser('userID')` fails to compile instead of silently yielding
 * `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    return data ? user?.[data] : user;
  },
);
