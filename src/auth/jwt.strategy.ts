import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { AppConfigService } from '../config/app-config.service';
import { Role } from '../generated/prisma/enums';
import { UsersService } from '../users/users.service';
import type { AuthenticatedUser } from './types/authenticated-request';

/** The claims AuthService puts into the token when signing it. */
interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

/**
 * Verifies the bearer token on incoming requests.
 *
 * Passport calls `validate()` only after it has checked the signature and the
 * expiry, so by the time our code runs the token is known to be genuine and
 * unexpired.
 *
 * ## Why this hits the database on every request
 *
 * The textbook JWT design does NOT do this: the whole appeal of a stateless
 * token is that it needs no lookup. The cost of that is staleness — the token
 * carries a snapshot of the user taken when it was issued, so a deactivation or
 * a role change is invisible until the token expires. With the conventional
 * 15-minute lifetime, that gap is small enough to accept.
 *
 * This project issues access tokens with a much longer lifetime by explicit
 * decision. At that length the gap is no longer acceptable: without a lookup,
 * revoking a fired employee's access would take up to a week to take effect.
 *
 * So we trade one indexed primary-key lookup per request for immediate
 * revocation. That is the right trade *given the long TTL* — and it is a good
 * illustration of a general point: a design decision in one place (token
 * lifetime) changes what is correct somewhere else entirely (whether to
 * verify against the database).
 *
 * Phase 8 can add a short-lived cache here if the lookup ever shows up in
 * profiling.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: AppConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Never set this to true. It would accept expired tokens, defeating the
      // only expiry mechanism a stateless token has.
      ignoreExpiration: false,
      secretOrKey: config.jwtSecret,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // A correctly signed token with the wrong shape means either the secret
    // leaked or we changed the payload without migrating. Refuse either way.
    if (!payload?.sub) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const user = await this.usersService.findActiveById(payload.sub);

    if (!user) {
      throw new UnauthorizedException(
        'Account is inactive or no longer exists',
      );
    }

    // The role comes from the DATABASE, not from the token. If an admin demotes
    // someone, the change applies to their very next request — a token minted
    // while they were an admin cannot be replayed to keep admin powers.
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
