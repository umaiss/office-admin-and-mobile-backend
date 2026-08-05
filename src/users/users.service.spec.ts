import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';

import { AppConfigService } from '../config/app-config.service';
import { Prisma } from '../generated/prisma/client';
import { Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { UsersService } from './users.service';

/**
 * These tests pin the parts of the admin user-directory that the database does
 * not enforce: how the list query becomes a Prisma `where` (role/isActive
 * filters, the name/email search OR), the pagination meta math, and — most
 * important — the security contract that deactivating or resetting an account
 * revokes every one of its refresh tokens and never returns the password hash.
 *
 * Prisma and RefreshTokenService are fully mocked. `$transaction` resolves the
 * array of promises the service hands it, exactly as the real client does.
 */
describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let refreshTokens: { revokeAllForUser: jest.Mock };

  /** First argument of a mock's first call, typed as a plain record. */
  const firstArg = (mock: jest.Mock): Record<string, any> => {
    const call = mock.mock.calls[0] as unknown[];
    return call[0] as Record<string, any>;
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops as Promise<unknown>[]) : undefined,
      ),
    };
    refreshTokens = {
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };

    // 10 rounds instead of 12 keeps tests fast — bcrypt is deliberately slow.
    const mockConfig = { bcryptSaltRounds: 10 };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AppConfigService, useValue: mockConfig },
        { provide: RefreshTokenService, useValue: refreshTokens },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // --------------------------------------------------------------------------
  //  findMany — where construction + meta
  // --------------------------------------------------------------------------
  describe('findMany', () => {
    it('builds a where from role, isActive, and a name/email search OR', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findMany({
        page: 1,
        limit: 20,
        role: Role.OFFICE_BOY,
        isActive: true,
        search: 'bil',
      });

      const where = firstArg(prisma.user.findMany).where as Record<string, any>;
      expect(where.role).toBe(Role.OFFICE_BOY);
      expect(where.isActive).toBe(true);
      expect(where.OR).toEqual([
        { name: { contains: 'bil', mode: 'insensitive' } },
        { email: { contains: 'bil', mode: 'insensitive' } },
      ]);
    });

    it('omits isActive from the where when not supplied (includes both)', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findMany({ page: 1, limit: 20 });

      const where = firstArg(prisma.user.findMany).where as Record<string, any>;
      expect(where).not.toHaveProperty('isActive');
      expect(where).not.toHaveProperty('role');
      expect(where).not.toHaveProperty('OR');
    });

    it('paginates with skip/take and reports meta', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(45);

      const { meta } = await service.findMany({ page: 3, limit: 20 });

      const arg = firstArg(prisma.user.findMany);
      expect(arg.skip).toBe(40);
      expect(arg.take).toBe(20);
      expect(meta).toMatchObject({
        page: 3,
        limit: 20,
        total: 45,
        totalPages: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  //  update — 404 translation
  // --------------------------------------------------------------------------
  describe('update', () => {
    it('translates Prisma P2025 into a 404', async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        {
          code: 'P2025',
          clientVersion: 'test',
        },
      );
      prisma.user.update.mockRejectedValue(p2025);

      await expect(
        service.update('missing-id', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  //  setActive — deactivate revokes sessions
  // --------------------------------------------------------------------------
  describe('setActive', () => {
    it('revokes all sessions when deactivating', async () => {
      prisma.user.update.mockResolvedValue({ id: 'u1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: false });

      await service.setActive('u1', false);

      expect(firstArg(prisma.user.update).data).toEqual({ isActive: false });
      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u1');
    });

    it('does NOT revoke sessions when activating', async () => {
      prisma.user.update.mockResolvedValue({ id: 'u1' });
      prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true });

      await service.setActive('u1', true);

      expect(refreshTokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  //  resetPassword — hashes, revokes, never returns the hash
  // --------------------------------------------------------------------------
  describe('resetPassword', () => {
    it('hashes the new password, revokes sessions, and returns only a message', async () => {
      prisma.user.update.mockResolvedValue({ id: 'u1' });

      const result = await service.resetPassword('u1', 'NewPassword123!');

      const data = firstArg(prisma.user.update).data as Record<string, any>;
      // The stored value is a bcrypt hash, never the plaintext.
      expect(data.password).toBeDefined();
      expect(data.password).not.toBe('NewPassword123!');
      await expect(
        bcrypt.compare('NewPassword123!', data.password as string),
      ).resolves.toBe(true);

      expect(refreshTokens.revokeAllForUser).toHaveBeenCalledWith('u1');
      // The response carries no hash, only a confirmation.
      expect(result.message).toContain('revoked');
      expect(JSON.stringify(result)).not.toContain(data.password);
    });
  });
});
