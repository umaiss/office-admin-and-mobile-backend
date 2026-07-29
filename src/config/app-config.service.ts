import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Env } from './env.schema';

/**
 * A typed, read-only view of the validated environment.
 *
 * ## Why this class exists instead of a type alias
 *
 * The obvious approach is `type AppConfigService = ConfigService<Env, true>`
 * and then injecting that. It does not work, and the reason is worth
 * understanding because it bites people repeatedly.
 *
 * Nest resolves constructor dependencies at RUNTIME, using metadata TypeScript
 * emits via `emitDecoratorMetadata`. That metadata records the runtime *value*
 * of each parameter's type. A `class` exists at runtime, so it emits the class.
 * A `type` alias is erased during compilation — nothing is left to emit — so
 * TypeScript writes `Object`, and Nest reports "dependency at index [n] is
 * undefined". The code type-checks perfectly and fails the moment it runs.
 *
 * ## Why a facade is better anyway
 *
 * Compare the two call sites:
 *
 *   config.get('JWT_ACCESS_TTL_SECONDS', { infer: true })   // stringly-typed
 *   config.jwtAccessTtlSeconds                              // just a property
 *
 * The first misspells silently at runtime; the second fails to compile. This
 * class is also the natural home for values that need *deriving* from raw
 * environment strings — see `corsOrigins` below — so that parsing happens once
 * here rather than being repeated wherever it is needed.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  /** Narrow helper: `infer: true` makes the return type follow the Env shape. */
  private read<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  // ---- Runtime -------------------------------------------------------------
  get nodeEnv(): Env['NODE_ENV'] {
    return this.read('NODE_ENV');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get isTest(): boolean {
    return this.nodeEnv === 'test';
  }

  get port(): number {
    return this.read('PORT');
  }

  // ---- Database ------------------------------------------------------------
  get databaseUrl(): string {
    return this.read('DATABASE_URL');
  }

  // ---- Authentication ------------------------------------------------------
  get jwtSecret(): string {
    return this.read('JWT_SECRET');
  }

  get jwtAccessTtlSeconds(): number {
    return this.read('JWT_ACCESS_TTL_SECONDS');
  }

  get jwtRefreshTtlSeconds(): number {
    return this.read('JWT_REFRESH_TTL_SECONDS');
  }

  get bcryptSaltRounds(): number {
    return this.read('BCRYPT_SALT_ROUNDS');
  }

  // ---- Rate limiting -------------------------------------------------------
  get throttleTtlSeconds(): number {
    return this.read('THROTTLE_TTL_SECONDS');
  }

  get throttleLimit(): number {
    return this.read('THROTTLE_LIMIT');
  }

  get authThrottleTtlSeconds(): number {
    return this.read('AUTH_THROTTLE_TTL_SECONDS');
  }

  get authThrottleLimit(): number {
    return this.read('AUTH_THROTTLE_LIMIT');
  }

  // ---- HTTP ----------------------------------------------------------------
  /**
   * CORS origins, parsed from a comma-separated string into a real array.
   *
   * Parsing lives here rather than in main.ts so that the raw string format is
   * an implementation detail of configuration, invisible to everything else.
   */
  get corsOrigins(): string[] {
    return this.read('CORS_ORIGINS')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  // ---- Observability -------------------------------------------------------
  get logLevel(): Env['LOG_LEVEL'] {
    return this.read('LOG_LEVEL');
  }

  get swaggerEnabled(): boolean {
    return this.read('SWAGGER_ENABLED');
  }
}
