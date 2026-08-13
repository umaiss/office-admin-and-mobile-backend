import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AppConfigService } from './config/app-config.service';
import { AppConfigModule } from './config/config.module';
import { buildLoggerConfig } from './config/logger.config';
import { EmployeesModule } from './employees/employees.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { PettyCashModule } from './petty-cash/petty-cash.module';
import { RefreshTokenModule } from './refresh-token/refresh-token.module';
import { TasksModule } from './tasks/tasks.module';
import { UsersModule } from './users/users.module';

/**
 * The application root.
 *
 * Infrastructure modules first (config, logging, rate limiting, database), then
 * feature modules. Order in the array does not affect behaviour — Nest resolves
 * the dependency graph itself — but grouping keeps the structure legible.
 */
@Module({
  imports: [
    AppConfigModule,

    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildLoggerConfig(config),
    }),

    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        throttlers: [
          // BOTH of these apply to EVERY route. A named throttler is not
          // opt-in: `@Throttle({ auth: {} })` on the login routes overrides
          // that throttler's options there, it does not switch it on. Anything
          // that should not be held to the auth limit therefore has to opt OUT
          // with `@SkipThrottle({ auth: true })` — see the controllers.
          //
          // Getting this backwards capped the entire API at the auth limit of
          // a few requests a minute, which looked like a client bug for as
          // long as nobody read the 429's `Retry-After-auth` header.
          {
            name: 'default',
            ttl: config.throttleTtlSeconds * 1000,
            limit: config.throttleLimit,
          },
          {
            name: 'auth',
            ttl: config.authThrottleTtlSeconds * 1000,
            limit: config.authThrottleLimit,
          },
        ],
      }),
    }),

    PrismaModule,

    // Feature modules
    HealthModule,
    AuthModule,
    UsersModule,
    EmployeesModule,
    TasksModule,
    PettyCashModule,
    AdminModule,
    RefreshTokenModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,

    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },

    /**
     * Global guards, in execution order.
     *
     * The order is deliberate and matters:
     *   1. Throttler   — reject floods before doing any real work. Putting this
     *                    after authentication would mean every attempt in a
     *                    brute-force run still costs a bcrypt comparison.
     *   2. JwtAuthGuard — who are you? (skipped on routes marked @Public())
     *   3. RolesGuard   — may you do this? Reads request.user, which only
     *                     exists because JwtAuthGuard ran first.
     *
     * Registering authentication GLOBALLY is the important change. Every route
     * in the application now requires a valid token by default, and must opt
     * out explicitly with @Public(). Forgetting the decorator produces a loud
     * 401 rather than a silently exposed endpoint.
     */
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
