import { ConflictException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';

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
}
