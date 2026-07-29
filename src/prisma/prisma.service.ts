import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

/**
 * Owns the single database connection pool for the whole application.
 *
 * It is registered in a `@Global()` module so every other module can inject it
 * without importing anything — there must be exactly one pool per process.
 * Creating a `PrismaClient` per module would open a new pool each time and
 * exhaust PostgreSQL's connection limit under load.
 *
 * `OnModuleInit` / `OnModuleDestroy` are Nest *lifecycle hooks*: methods Nest
 * calls automatically as the application starts and stops. Using them ties
 * connection handling to the app's lifecycle rather than to whoever remembers
 * to call connect/disconnect.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    // Prisma 7 talks to PostgreSQL through a driver adapter rather than a
    // native engine binary. The adapter owns the connection pool.
    super({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  /**
   * Closes the pool during shutdown.
   *
   * Without this, every redeploy leaves PostgreSQL holding connections it only
   * reclaims after a timeout. Do enough rapid deploys and new instances cannot
   * connect at all, because the old dead ones still hold the slots.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /** Cheapest possible round-trip, used by the readiness probe. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
