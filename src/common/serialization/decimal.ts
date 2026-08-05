/**
 * Turning Prisma `Decimal` columns back into plain JSON numbers.
 *
 * ## Why this is needed
 *
 * Money is stored as `Decimal(12,2)` because summing currency in a float
 * accumulates error. But Prisma hands `Decimal` back as a decimal.js instance,
 * and `JSON.stringify` on one produces a **string**: an API that returns
 * `"amountReceived": "500"` where every other numeric field is a number is a
 * trap for every client that consumes it.
 *
 * So: `Decimal` at rest, `number` on the wire. The conversion happens here, at
 * one boundary, rather than being remembered at each of the dozen places a task
 * is serialised.
 *
 * ## Why the input type is structural
 *
 * `Decimal` is only reachable through `@prisma/client/runtime/client`, a path
 * that has moved between Prisma majors. Accepting anything with a `toNumber`
 * keeps this file independent of that, and makes it trivial to unit test with a
 * plain object.
 */

/** Anything decimal-like: a Prisma `Decimal`, or a raw number/string from SQL. */
export type DecimalLike = { toNumber(): number } | number | string;

/**
 * A decimal-like value as a `number`. `null`/`undefined` pass straight through,
 * so a nullable column stays nullable rather than silently becoming 0 — the
 * difference between "no receipt amount recorded" and "recorded as zero" is
 * meaningful to an accountant.
 */
export function decimalToNumber(value: DecimalLike): number;
export function decimalToNumber(
  value: DecimalLike | null | undefined,
): number | null;
export function decimalToNumber(
  value: DecimalLike | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value);
  }
  return value.toNumber();
}

/**
 * Same, but for sums that are semantically zero when absent.
 *
 * Prisma's `_sum` returns `null` when the aggregate matched no rows. Every
 * report here wants "0.00 spent" rather than "unknown", so this collapses that
 * one case — and only that case.
 */
export function decimalSumToNumber(
  value: DecimalLike | null | undefined,
): number {
  return decimalToNumber(value) ?? 0;
}

/**
 * Rounds a currency amount to 2 decimal places.
 *
 * Even with `Decimal` in the database, the arithmetic that derives a
 * reimbursement (metres ÷ 1000 × rate) happens in JavaScript floats, so
 * `0.1 + 0.2` problems still reach the response without this.
 */
export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
