import { Env, validatedEnvSchema } from './env.schema';

/**
 * Validates `process.env` at application startup.
 *
 * This function is handed to `ConfigModule.forRoot({ validate })`, which calls
 * it once, before any module is constructed. If it throws, Nest never finishes
 * booting.
 *
 * That is the entire point. There are two ways to handle a missing or malformed
 * environment variable:
 *
 *   1. Fail lazily  — start fine, then crash at 03:00 when the first user hits
 *                     the code path that reads it. This is a production
 *                     incident, at night, with users affected.
 *   2. Fail fast    — refuse to start, printing exactly which variables are
 *                     wrong. This is a deployment that simply does not happen,
 *                     with the previous version still serving traffic.
 *
 * Fail-fast converts a 3am incident into a red build. Always prefer it.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = validatedEnvSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map(
        (issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');

    throw new Error(
      `\n\nInvalid environment configuration:\n${problems}\n\n` +
        `Fix your .env file (see .env.example for the full list) and restart.\n`,
    );
  }

  return result.data;
}
