import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';

import { AppConfigService } from '../config/app-config.service';
import { Role } from '../generated/prisma/enums';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<
    Pick<
      UsersService,
      | 'findByEmailWithPassword'
      | 'findById'
      | 'findActiveById'
      | 'touchLastLogin'
    >
  >;
  let refreshTokenService: jest.Mocked<
    Pick<
      RefreshTokenService,
      'issue' | 'rotate' | 'revoke' | 'revokeAllForUser'
    >
  >;

  const publicUser = {
    id: 'user-123',
    name: 'Test Admin',
    email: 'admin@example.com',
    phone: '+923001234567',
    role: Role.ADMIN,
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const userWithPassword = { ...publicUser, password: '$2b$12$hashedpassword' };

  beforeEach(async () => {
    jest.clearAllMocks();

    usersService = {
      findByEmailWithPassword: jest.fn(),
      findById: jest.fn(),
      findActiveById: jest.fn(),
      touchLastLogin: jest.fn().mockResolvedValue(undefined),
    };

    refreshTokenService = {
      issue: jest.fn().mockResolvedValue({
        token: 'token-id.secret',
        expiresAt: new Date(Date.now() + 2592000_000),
      }),
      rotate: jest.fn(),
      revoke: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue('jwt_access_token'),
          },
        },
        { provide: RefreshTokenService, useValue: refreshTokenService },
        {
          provide: AppConfigService,
          useValue: {
            jwtAccessTtlSeconds: 604800,
            jwtRefreshTtlSeconds: 2592000,
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('login', () => {
    it('returns tokens and a user object with no password field', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(userWithPassword);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.login({
        email: 'admin@example.com',
        password: 'password123',
      });

      expect(result.accessToken).toBe('jwt_access_token');
      expect(result.refreshToken).toBe('token-id.secret');
      expect(result.expiresIn).toBe(604800);
      expect(result.user).not.toHaveProperty('password');
    });

    it('records the login timestamp', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(userWithPassword);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.login({
        email: 'admin@example.com',
        password: 'password123',
      });

      expect(usersService.touchLastLogin).toHaveBeenCalledWith('user-123');
    });

    it('rejects an unknown email', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'password123' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('still runs a hash comparison for an unknown email', async () => {
      // Guards against timing-based user enumeration: a missing account must
      // not return measurably faster than a wrong password.
      usersService.findByEmailWithPassword.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nobody@example.com', password: 'password123' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(bcrypt.compare).toHaveBeenCalled();
    });

    it('rejects a wrong password', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(userWithPassword);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ email: 'admin@example.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a deactivated account even with the correct password', async () => {
      // The regression this phase existed to fix: before it, deactivating an
      // account had no effect on login whatsoever.
      usersService.findByEmailWithPassword.mockResolvedValue({
        ...userWithPassword,
        isActive: false,
      });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await expect(
        service.login({ email: 'admin@example.com', password: 'password123' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(refreshTokenService.issue).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('issues a new pair when the token rotates successfully', async () => {
      refreshTokenService.rotate.mockResolvedValue({
        ok: true,
        userId: 'user-123',
        token: 'new-id.new-secret',
        expiresAt: new Date(),
      });
      usersService.findActiveById.mockResolvedValue(publicUser);

      const result = await service.refresh('token-id.secret');

      expect(result).toEqual({
        accessToken: 'jwt_access_token',
        refreshToken: 'new-id.new-secret',
        expiresIn: 604800,
      });
    });

    it('rejects an invalid token', async () => {
      refreshTokenService.rotate.mockResolvedValue({
        ok: false,
        reason: 'NOT_FOUND',
      });

      await expect(service.refresh('bogus.token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a reused token', async () => {
      refreshTokenService.rotate.mockResolvedValue({
        ok: false,
        reason: 'REUSED',
      });

      await expect(service.refresh('stolen.token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('refuses to extend a session whose account was deactivated mid-session', async () => {
      refreshTokenService.rotate.mockResolvedValue({
        ok: true,
        userId: 'user-123',
        token: 'new-id.new-secret',
        expiresAt: new Date(),
      });
      usersService.findActiveById.mockResolvedValue(null);

      await expect(service.refresh('token-id.secret')).rejects.toThrow(
        UnauthorizedException,
      );

      // And the now-orphaned sessions are cleaned up rather than left usable.
      expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(
        'user-123',
      );
    });
  });

  describe('logout', () => {
    it('revokes only the presented token', async () => {
      await service.logout('token-id.secret');

      expect(refreshTokenService.revoke).toHaveBeenCalledWith(
        'token-id.secret',
      );
      expect(refreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('logoutAll', () => {
    it('revokes every session for the user', async () => {
      await service.logoutAll('user-123');

      expect(refreshTokenService.revokeAllForUser).toHaveBeenCalledWith(
        'user-123',
      );
    });
  });

  describe('getProfile', () => {
    it('returns the profile without a password', async () => {
      usersService.findById.mockResolvedValue(publicUser);

      const result = await service.getProfile('user-123');

      expect(result).toEqual(publicUser);
      expect(result).not.toHaveProperty('password');
    });

    it('throws when the user does not exist', async () => {
      usersService.findById.mockResolvedValue(null);

      await expect(service.getProfile('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
