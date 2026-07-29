import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { TokenContext } from '../refresh-token/refresh-token.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { Public } from './decorators/public.decorator';
import { AuthResponseDto, AuthTokensDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

/**
 * Reads the caller's device fingerprint from the request.
 *
 * Stored alongside each refresh token so that "log out this phone" can revoke
 * one session rather than all of them, and so that a suspicious session is
 * identifiable in an audit.
 */
function tokenContextFrom(request: Request): TokenContext {
  return {
    userAgent: request.get('user-agent') ?? undefined,
    ipAddress: request.ip,
  };
}

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  // A far stricter rate limit than the rest of the API. Without it, this
  // endpoint is an unlimited password-guessing oracle.
  @Throttle({ auth: {} })
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials, or the account is deactivated.',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many attempts.' })
  login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
  ): Promise<AuthResponseDto> {
    return this.authService.login(loginDto, tokenContextFrom(request));
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: {} })
  @ApiOperation({
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'The old refresh token is revoked and a new one returned. Store the new one — ' +
      'presenting the old one again is treated as theft and ends every session for that user.',
  })
  @ApiOkResponse({ type: AuthTokensDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired, or reused token.',
  })
  refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<AuthTokensDto> {
    // Deliberately @Public(): the refresh token IS the credential here. The
    // whole point of this endpoint is to be callable once the access token has
    // expired, so requiring a valid access token would make it useless.
    return this.authService.refresh(
      refreshTokenDto.refreshToken,
      tokenContextFrom(request),
    );
  }

  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End the session on this device',
    description:
      'Revokes the supplied refresh token. Other devices are unaffected.',
  })
  async logout(@Body() refreshTokenDto: RefreshTokenDto) {
    await this.authService.logout(refreshTokenDto.refreshToken);
    // Always reports success, even for an unknown token. Logging out is not an
    // operation a caller should be able to probe for information, and a client
    // clearing local state should never be blocked by an error.
    return { message: 'Logged out successfully' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'End every session, on all devices',
    description: 'Use after a password change or a suspected compromise.',
  })
  async logoutAll(@CurrentUser('userId') userId: string) {
    await this.authService.logoutAll(userId);
    return { message: 'All sessions ended' };
  }

  @Get('profile')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The signed-in user’s own profile' })
  getProfile(@CurrentUser('userId') userId: string) {
    return this.authService.getProfile(userId);
  }
}
