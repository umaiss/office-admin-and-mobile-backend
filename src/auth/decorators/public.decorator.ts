import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * From this phase onward, `JwtAuthGuard` is registered globally, so **every**
 * endpoint requires a valid token unless it carries this decorator.
 *
 * That inversion matters more than it looks. With per-route `@UseGuards(...)`,
 * forgetting the decorator leaves an endpoint publicly exposed — a silent
 * failure that looks like working code and is invisible in review. With a
 * global guard, forgetting `@Public()` makes the endpoint return 401: a loud,
 * immediate failure that is caught the first time anyone calls it.
 *
 * The general principle is **fail closed**: when someone makes a mistake, the
 * system should deny access rather than grant it. Design so the easy path is
 * the safe one.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
