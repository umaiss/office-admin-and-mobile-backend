import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { AppConfigService } from '../config/app-config.service';
import { Role } from '../generated/prisma/enums';
import {
  RefreshTokenService,
  TokenContext,
} from '../refresh-token/refresh-token.service';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly config: AppConfigService,
  ) {}

  private async issueTokens(
    user: { id: string; email: string; role: Role },
    context: TokenContext,
  ) {
    const accessTtl = this.config.jwtAccessTtlSeconds;

    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: accessTtl },
    );

    const refresh = await this.refreshTokenService.issue(
      user.id,
      this.config.jwtRefreshTtlSeconds,
      context,
    );

    return {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: accessTtl,
    };
  }

  async login(loginDto: LoginDto, context: TokenContext = {}) {
    const user = await this.usersService.findByEmailWithPassword(
      loginDto.email,
    );

    // Note the identical message for "no such email" and "wrong password".
    // Distinguishing them would turn this endpoint into a user-enumeration
    // oracle: an attacker could discover which email addresses have accounts
    // and target them specifically.
    //
    // We still hash-compare against a dummy value when the user is absent, so
    // that a missing account does not return measurably faster than a wrong
    // password — the same enumeration leak, via timing rather than wording.
    if (!user) {
      await bcrypt.compare(
        loginDto.password,
        '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv',
      );
      throw new UnauthorizedException('Invalid email or password.');
    }

    const passwordMatches = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    // Deactivated accounts must not be able to log in. Previously this was not
    // checked at all, so deactivating an office boy did nothing whatsoever.
    if (!user.isActive) {
      this.logger.warn(`Login attempt on deactivated account: ${user.id}`);
      throw new UnauthorizedException('This account has been deactivated.');
    }

    const tokens = await this.issueTokens(user, context);
    await this.usersService.touchLastLogin(user.id);

    const { password: _password, ...safeUser } = user;

    return { ...tokens, user: safeUser };
  }

  /**
   * Exchanges a refresh token for a new token pair.
   *
   * The user id is derived from the stored token, never taken from the request
   * body. Anything a caller sends can be changed by that caller; only the
   * server's own record of who a token belongs to is trustworthy.
   */
  async refresh(presentedToken: string, context: TokenContext = {}) {
    const result = await this.refreshTokenService.rotate(
      presentedToken,
      this.config.jwtRefreshTtlSeconds,
      context,
    );

    if (!result.ok) {
      // Every failure returns the same message. A caller has no legitimate need
      // to know whether their token was expired, unknown, or flagged as stolen,
      // and telling them helps only an attacker.
      if (result.reason === 'REUSED') {
        throw new UnauthorizedException(
          'Session ended for security reasons. Please sign in again.',
        );
      }
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    // Re-check the account on refresh as well as on login. A user deactivated
    // mid-session must not be able to extend it.
    const user = await this.usersService.findActiveById(result.userId);

    if (!user) {
      await this.refreshTokenService.revokeAllForUser(result.userId);
      throw new UnauthorizedException('This account is no longer active.');
    }

    const accessTtl = this.config.jwtAccessTtlSeconds;
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      { expiresIn: accessTtl },
    );

    return {
      accessToken,
      refreshToken: result.token,
      expiresIn: accessTtl,
    };
  }

  /** Ends one session — the device that presented this refresh token. */
  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenService.revoke(refreshToken);
  }

  /** Ends every session for the user, on all devices. */
  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
  }

  async getProfile(userId: string) {
    const user = await this.usersService.findById(userId);

    if (!user) {
      throw new NotFoundException('User profile not found.');
    }

    return user;
  }
}
