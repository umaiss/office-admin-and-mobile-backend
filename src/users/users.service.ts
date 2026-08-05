import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { buildPaginationMeta } from '../common/pagination/paginate';
import { AppConfigService } from '../config/app-config.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token/refresh-token.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * The fields safe to return from an API.
 *
 * Defining this once, as a Prisma `select`, is stronger than remembering to
 * strip `password` at each call site. A field can only leak if someone
 * deliberately adds it here — whereas `delete user.password` fails silently the
 * day someone adds a second sensitive column.
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    // Deactivating or resetting an account must kill its live sessions, not just
    // block the next login — this is how those two operations do it.
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  async create(createUserDto: CreateUserDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createUserDto.email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException('Email already exists.');
    }

    const hashedPassword = await bcrypt.hash(
      createUserDto.password,
      this.config.bcryptSaltRounds,
    );

    return this.prisma.user.create({
      data: {
        name: createUserDto.name,
        email: createUserDto.email,
        password: hashedPassword,
        phone: createUserDto.phone,
        role: createUserDto.role,
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  /**
   * Looks a user up for authentication. Returns the password hash, so this is
   * the one method whose result must never reach a response.
   */
  async findByEmailWithPassword(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_USER_SELECT,
    });
  }

  /**
   * The per-request identity check behind every authenticated route.
   *
   * Returns null when the user has been deleted or deactivated, so a token
   * issued before deactivation stops working immediately rather than lingering
   * until it expires. With this project's long access-token lifetime, that
   * difference is the whole point — without this check, revoking someone's
   * access would take up to a week to take effect.
   */
  async findActiveById(id: string) {
    return this.prisma.user.findFirst({
      where: { id, isActive: true },
      select: PUBLIC_USER_SELECT,
    });
  }

  /** Records a successful login, for the dashboard's activity view. */
  async touchLastLogin(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }

  // --------------------------------------------------------------------------
  //  GET /users — the admin directory
  // --------------------------------------------------------------------------
  /**
   * A paginated, filterable page of users. The `findMany` + `count` pair runs in
   * one transaction so the page and the total describe the same snapshot, exactly
   * as the task lists do.
   */
  async findMany(query: ListUsersQueryDto) {
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...this.searchClause(query.search),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items,
      meta: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  // --------------------------------------------------------------------------
  //  PATCH /users/:id — edit mutable profile fields
  // --------------------------------------------------------------------------
  /**
   * Updates the profile fields the DTO allows (name/phone only — email and role
   * are excluded by design). Prisma throws P2025 when the id does not exist; we
   * translate that into a clean 404 rather than leaking the driver error.
   */
  async update(id: string, dto: UpdateUserDto) {
    try {
      return await this.prisma.user.update({
        where: { id },
        data: dto,
        select: PUBLIC_USER_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('User not found.');
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  //  POST /users/:id/activate · /deactivate
  // --------------------------------------------------------------------------
  /**
   * Flips the soft-delete flag. Deactivating also revokes every refresh token the
   * account holds, so a disabled account cannot keep minting fresh access tokens
   * from a session that outlived the click.
   */
  async setActive(id: string, isActive: boolean) {
    try {
      await this.prisma.user.update({
        where: { id },
        data: { isActive },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('User not found.');
      }
      throw error;
    }

    if (!isActive) {
      await this.refreshTokens.revokeAllForUser(id);
    }

    // Re-read through the public allowlist so the response shape matches every
    // other user endpoint exactly.
    return this.findById(id);
  }

  // --------------------------------------------------------------------------
  //  POST /users/:id/reset-password
  // --------------------------------------------------------------------------
  /**
   * Sets a new password chosen by the admin, then revokes every session on the
   * account so the old password's live tokens die with it. Returns only a
   * confirmation — the hash never leaves the service.
   */
  async resetPassword(
    id: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const hashedPassword = await bcrypt.hash(
      newPassword,
      this.config.bcryptSaltRounds,
    );

    try {
      await this.prisma.user.update({
        where: { id },
        data: { password: hashedPassword },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('User not found.');
      }
      throw error;
    }

    await this.refreshTokens.revokeAllForUser(id);
    return { message: 'Password reset. All existing sessions were revoked.' };
  }

  /** Case-insensitive contains across name and email. */
  private searchClause(search?: string): Prisma.UserWhereInput {
    if (!search) {
      return {};
    }
    return {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    };
  }
}
