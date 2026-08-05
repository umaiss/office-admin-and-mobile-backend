import type { TransformFnParams } from 'class-transformer';

/**
 * Parses a boolean out of a query string.
 *
 * `@Type(() => Boolean)` cannot be used for this, and the reason is worth
 * stating plainly because it has already caused one live bug here: `Type`
 * calls `Boolean(value)`, and `Boolean('false')` is `true` — every non-empty
 * string is truthy. A caller passing `?completedToday=false` therefore turned
 * the filter ON, the exact opposite of what they asked for, silently.
 *
 * This maps the two literal strings explicitly and passes anything else through
 * untouched so `@IsBoolean()` rejects it with a real validation error rather
 * than coercing nonsense into `true`.
 */
export function parseBoolean({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value as unknown;
}
