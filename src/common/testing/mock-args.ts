/**
 * Typed accessors for the arguments a jest mock was called with.
 *
 * `mock.mock.calls` is typed `any[][]`, so reading `calls[0][0].where` in a test
 * trips `no-unsafe-member-access` on every property access — and the usual
 * workaround (a local `firstArg` helper) had already been copy-pasted into four
 * spec files. These are that helper, once.
 *
 * The `Record<string, any>` return is deliberate and confined to test code: a
 * spec asserting on a Prisma query object genuinely does not know its shape
 * ahead of time, and inventing a type for each one would assert nothing extra.
 */

/** The nth argument of a mock's first call. */
export function firstArg(mock: jest.Mock, argIndex = 0): Record<string, any> {
  return callArg(mock, 0, argIndex);
}

/** The `argIndex`th argument of the `callIndex`th call. */
export function callArg(
  mock: jest.Mock,
  callIndex: number,
  argIndex = 0,
): Record<string, any> {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(
      `Expected the mock to have been called at least ${callIndex + 1} time(s).`,
    );
  }
  return call[argIndex] as Record<string, any>;
}

/** The `argIndex`th argument of the most recent call. */
export function lastArg(mock: jest.Mock, argIndex = 0): Record<string, any> {
  return callArg(mock, mock.mock.calls.length - 1, argIndex);
}

/**
 * The `where` clause a Prisma mock was called with — by far the commonest thing
 * these specs assert on, and the one that otherwise needs a cast at every site
 * to keep a second-level property access out of `any`.
 *
 * `callIndex` defaults to the first call; pass `-1` for the most recent.
 */
export function whereArg(mock: jest.Mock, callIndex = 0): Record<string, any> {
  const args = callIndex < 0 ? lastArg(mock) : callArg(mock, callIndex);
  return args.where as Record<string, any>;
}
