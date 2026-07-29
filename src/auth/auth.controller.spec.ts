import { Test, TestingModule } from '@nestjs/testing';
import type { Request } from 'express';

import { Role } from '../generated/prisma/enums';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<
    Pick<
      AuthService,
      'login' | 'refresh' | 'logout' | 'logoutAll' | 'getProfile'
    >
  >;

  /** The two request properties the controller reads, and nothing else. */
  function mockRequest(
    userAgent = 'OBTrack/1.0 (Android)',
    ip = '203.0.113.7',
  ): Request {
    return {
      get: (header: string) =>
        header.toLowerCase() === 'user-agent' ? userAgent : undefined,
      ip,
    } as unknown as Request;
  }

  beforeEach(async () => {
    authService = {
      login: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn(),
      logoutAll: jest.fn(),
      getProfile: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('login', () => {
    it('passes credentials and the device context to the service', async () => {
      const loginDto = {
        email: 'admin@obtrack.local',
        password: 'ChangeMe123!',
      };
      const expected = {
        accessToken: 'access_token_123',
        refreshToken: 'token-id.secret',
        expiresIn: 604800,
        user: {
          id: 'user-1',
          name: 'Admin',
          email: 'admin@obtrack.local',
          phone: null,
          role: Role.ADMIN,
          isActive: true,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };

      authService.login.mockResolvedValue(expected);

      const result = await controller.login(loginDto, mockRequest());

      // The device fingerprint must reach the service — it is what makes
      // per-device logout possible.
      expect(authService.login).toHaveBeenCalledWith(loginDto, {
        userAgent: 'OBTrack/1.0 (Android)',
        ipAddress: '203.0.113.7',
      });
      expect(result).toBe(expected);
    });
  });

  describe('refresh', () => {
    it('forwards only the token — never a caller-supplied user id', async () => {
      const expected = {
        accessToken: 'new_access_token',
        refreshToken: 'new-id.new-secret',
        expiresIn: 604800,
      };

      authService.refresh.mockResolvedValue(expected);

      const result = await controller.refresh(
        { refreshToken: 'token-id.secret' },
        mockRequest(),
      );

      expect(authService.refresh).toHaveBeenCalledWith('token-id.secret', {
        userAgent: 'OBTrack/1.0 (Android)',
        ipAddress: '203.0.113.7',
      });
      expect(result).toBe(expected);
    });
  });

  describe('logout', () => {
    it('revokes the presented token only', async () => {
      authService.logout.mockResolvedValue(undefined);

      const result = await controller.logout({
        refreshToken: 'token-id.secret',
      });

      expect(authService.logout).toHaveBeenCalledWith('token-id.secret');
      expect(result).toEqual({ message: 'Logged out successfully' });
    });
  });

  describe('logoutAll', () => {
    it('revokes every session for the authenticated user', async () => {
      authService.logoutAll.mockResolvedValue(undefined);

      const result = await controller.logoutAll('user-1');

      expect(authService.logoutAll).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ message: 'All sessions ended' });
    });
  });

  describe('getProfile', () => {
    it('uses the id from the verified token, not from the request', async () => {
      const profile = {
        id: 'user-1',
        name: 'Admin',
        email: 'admin@obtrack.local',
        phone: null,
        role: Role.ADMIN,
        isActive: true,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      authService.getProfile.mockResolvedValue(profile);

      const result = await controller.getProfile('user-1');

      expect(authService.getProfile).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(profile);
    });
  });
});
