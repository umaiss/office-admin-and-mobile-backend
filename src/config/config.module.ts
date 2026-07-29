import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.validation';

/**
 * Loads, validates, and exposes configuration.
 *
 * `@Global()` means any module can inject `AppConfigService` without importing
 * this module first. Global modules should be rare — they hide dependencies —
 * but configuration and the database connection are the two classic, accepted
 * exceptions: virtually everything needs them, and there is exactly one of each.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      // Runs our Zod schema over process.env before any module is constructed.
      // If it throws, the application never finishes booting.
      validate: validateEnv,

      // Read values once at startup rather than on every get() call.
      cache: true,

      envFilePath: ['.env'],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
