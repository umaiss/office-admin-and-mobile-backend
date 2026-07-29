import { z } from 'zod';

/**
 * A "boolean" environment variable.
 *
 * Note we do NOT use `z.coerce.boolean()`. Coercion calls JavaScript's
 * `Boolean(value)`, and `Boolean('false')` is `true` — because any non-empty
 * string is truthy. That would silently enable a feature you explicitly turned
 * off. Parsing the literal strings is the only safe way.
 */
const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/**
 * The complete contract between this application and its environment.
 *
 * Every variable the app reads must be declared here. Nothing else in the
 * codebase is allowed to touch `process.env` directly — that rule is what makes
 * this file a single, trustworthy source of truth.
 */
export const envSchema = z.object({
  // ---- Runtime -------------------------------------------------------------
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // ---- Database ------------------------------------------------------------
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string',
    ),

  // ---- Authentication ------------------------------------------------------
  // 32 characters is the minimum length at which a secret has enough entropy
  // to resist offline brute-forcing of the token signature.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters long'),

  // Durations are stored as seconds, not as strings like "15m". A number needs
  // no parsing, cannot be malformed, and can be handed straight to jsonwebtoken.
  //
  // NOTE ON THE ACCESS TOKEN LIFETIME
  // A JWT cannot be revoked — the server does not store it, so there is no
  // record to invalidate. Its lifetime is therefore the maximum window during
  // which a stolen token keeps working. The usual value is 900 (15 minutes).
  //
  // This project runs a much longer access token by explicit decision. To keep
  // that safe, `JwtStrategy` re-checks the user against the database on every
  // request, so deactivating an account takes effect immediately rather than
  // whenever the token happens to expire. If you shorten this back to 900, that
  // database check becomes optional rather than essential.
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(604800), // 7 days

  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2592000), // 30 days

  // Higher = slower to hash = slower to brute-force. 12 is the current
  // sensible default; below 10 is too fast, above 14 hurts login latency.
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),

  // ---- Rate limiting -------------------------------------------------------
  // General ceiling for ordinary API traffic.
  THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),

  // Much stricter ceiling for authentication endpoints. Without one, the login
  // route is an unlimited password-guessing oracle: an attacker can try
  // millions of passwords against a known email address. Strong password rules
  // do not help against credential stuffing, where the password is already
  // known — only rate limiting does.
  AUTH_THROTTLE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_THROTTLE_LIMIT: z.coerce.number().int().positive().default(5),

  // ---- HTTP ----------------------------------------------------------------
  // Comma-separated list of browser origins allowed to call this API.
  // Empty means "no browser origins" — mobile apps are unaffected by CORS.
  CORS_ORIGINS: z.string().default(''),

  // ---- Observability -------------------------------------------------------
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  SWAGGER_ENABLED: booleanFromString.default(false),
});

/** The fully parsed, defaulted, type-safe shape of our environment. */
export type Env = z.infer<typeof envSchema>;
