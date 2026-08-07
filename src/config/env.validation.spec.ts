import { validateEnv } from './env.validation';

/**
 * The config layer's promise is fail-fast: a bad environment stops the container
 * starting, rather than surfacing at 3am as a crash in whatever code path first
 * reads the variable. These tests cover the rules that are easy to get wrong —
 * the cross-field S3 requirement, and the boolean parsing that a naive
 * `Boolean(value)` would invert.
 */
describe('validateEnv', () => {
  /** The minimum a valid environment needs; everything else has a default. */
  const base = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    JWT_SECRET: 'a'.repeat(32),
  };

  it('accepts a minimal environment and applies defaults', () => {
    const env = validateEnv({ ...base });

    expect(env.STORAGE_DRIVER).toBe('local');
    expect(env.UPLOADS_DIR).toBe('./uploads');
    expect(env.REPORT_TZ_OFFSET_MINUTES).toBe(0);
  });

  it('does not require a bucket under the local driver', () => {
    expect(() =>
      validateEnv({ ...base, STORAGE_DRIVER: 'local' }),
    ).not.toThrow();
  });

  it('refuses to boot with STORAGE_DRIVER=s3 and no bucket, naming the variable', () => {
    // Without this rule the S3 client would politely try to write to a bucket
    // named `undefined`, and the first failure would be an upload, not a deploy.
    expect(() => validateEnv({ ...base, STORAGE_DRIVER: 's3' })).toThrow(
      /S3_BUCKET.*required when STORAGE_DRIVER=s3/s,
    );
  });

  it('accepts the s3 driver once a bucket is supplied', () => {
    const env = validateEnv({
      ...base,
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'obtrack-receipts',
      S3_REGION: 'eu-north-1',
    });

    expect(env.S3_BUCKET).toBe('obtrack-receipts');
    expect(env.S3_REGION).toBe('eu-north-1');
  });

  it('rejects an unknown storage driver rather than silently falling back', () => {
    expect(() => validateEnv({ ...base, STORAGE_DRIVER: 'gcs' })).toThrow();
  });

  it('parses the literal string "false" as false, not as truthy', () => {
    // `z.coerce.boolean()` would make this `true`, quietly enabling something
    // that was explicitly turned off — the same class of bug the query-string
    // `parseBoolean` transform exists to prevent.
    const env = validateEnv({
      ...base,
      SWAGGER_ENABLED: 'false',
      S3_FORCE_PATH_STYLE: 'false',
    });

    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('rejects a JWT secret too short to resist offline brute-forcing', () => {
    expect(() => validateEnv({ ...base, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      validateEnv({ ...base, DATABASE_URL: 'mysql://user:pass@localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });
});
