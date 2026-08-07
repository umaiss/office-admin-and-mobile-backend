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

  /** Number of reverse proxies in front of the app; 0 means none. */
  get trustProxyHops(): number {
    return this.read('TRUST_PROXY_HOPS');
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

  // ---- File storage --------------------------------------------------------
  /** Which storage backend receipts live in: `local` or `s3`. */
  get storageDriver(): Env['STORAGE_DRIVER'] {
    return this.read('STORAGE_DRIVER');
  }

  /**
   * Bucket receipts are stored in.
   *
   * Non-null asserted because `validatedEnvSchema` refuses to boot with
   * `STORAGE_DRIVER=s3` and no bucket, and this getter is only ever read by the
   * S3 driver — which only exists under that setting. The alternative, a
   * `string | undefined` that every call site re-checks, would be re-proving a
   * guarantee the config layer already made.
   */
  get s3Bucket(): string {
    return this.read('S3_BUCKET')!;
  }

  get s3Region(): string {
    return this.read('S3_REGION');
  }

  /** Set only for S3-compatible services; undefined means real AWS. */
  get s3Endpoint(): string | undefined {
    return this.read('S3_ENDPOINT');
  }

  get s3ForcePathStyle(): boolean {
    return this.read('S3_FORCE_PATH_STYLE');
  }

  /** Root directory the local-disk storage driver writes receipts under. */
  get uploadsDir(): string {
    return this.read('UPLOADS_DIR');
  }

  /** Largest receipt upload accepted, in bytes. */
  get maxReceiptBytes(): number {
    return this.read('MAX_RECEIPT_BYTES');
  }

  // ---- Reporting -----------------------------------------------------------
  /**
   * Minutes to add to UTC to reach the calendar day reports are bucketed by.
   * Consumed by `todayUtcRange`; see the note in `env.schema.ts` for why the
   * server's own timezone is not used.
   */
  get reportTzOffsetMinutes(): number {
    return this.read('REPORT_TZ_OFFSET_MINUTES');
  }

  // ---- Observability -------------------------------------------------------
  get logLevel(): Env['LOG_LEVEL'] {
    return this.read('LOG_LEVEL');
  }

  get swaggerEnabled(): boolean {
    return this.read('SWAGGER_ENABLED');
  }
}
