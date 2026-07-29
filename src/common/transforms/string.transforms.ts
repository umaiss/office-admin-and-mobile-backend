import type { TransformFnParams } from 'class-transformer';

/**
 * Reusable `@Transform` callbacks for normalising incoming strings.
 *
 * These exist as named functions rather than inline arrow functions for two
 * reasons. First, normalisation rules should be identical everywhere — an email
 * lowercased on login but not on account creation produces two accounts that
 * look the same. Second, `TransformFnParams.value` is typed `any`, so handling
 * the narrowing once here keeps the `any` contained instead of spreading it
 * through every DTO.
 *
 * Each one passes non-string input through untouched, leaving the actual
 * type-checking to the `class-validator` decorators that run alongside.
 */

/** Trims surrounding whitespace. */
export function trim({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : (value as unknown);
}

/**
 * Trims and lowercases — the correct normalisation for email addresses.
 *
 * Email domains are case-insensitive, and in practice every mail provider
 * treats the local part that way too. Without this, `Admin@x.com` and
 * `admin@x.com` become two separate accounts, and a login fails purely because
 * a phone keyboard capitalised the first letter.
 */
export function trimAndLowercase({ value }: TransformFnParams): unknown {
  return typeof value === 'string'
    ? value.trim().toLowerCase()
    : (value as unknown);
}
