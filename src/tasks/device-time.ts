/**
 * Deciding when an errand actually happened.
 *
 * ## Why the device's clock matters
 *
 * The office boy's phone is the only witness to when a task started and ended,
 * and the app is built to work offline — `TaskLocation.clientId` exists
 * precisely so points recorded with no signal can be synced later without
 * duplicating. An errand run at 4pm and synced at 9pm must still be recorded as
 * 4pm.
 *
 * Stamping server time instead got three things wrong at once:
 *
 *   - `durationSeconds` came out at 0, because start and end were both stamped
 *     at the moment the request arrived. Every KPI built on duration — average
 *     errand time, office boy performance, employee hours saved — was reading
 *     from a column that was always zero for offline-synced work.
 *   - The expense booked into the month the phone happened to sync in. An
 *     errand on the 31st syncing on the 1st landed in the wrong month.
 *   - The `recordedAt` the DTOs require and validate was simply discarded.
 *
 * ## Why it is not trusted blindly
 *
 * It is also attacker-controlled, and `endedAt` decides which monthly ledger an
 * expense lands in — so a free hand with it means a free hand over which
 * month's budget absorbs the spend. A reported time is therefore honoured only
 * inside a plausible window, and anything outside falls back to server time,
 * which is at worst late but never chosen.
 */

/** Phones drift, and a request takes time to arrive. */
const CLOCK_SKEW_MS = 5 * 60_000;

/** How far back an offline sync may plausibly reach. */
const OFFLINE_HORIZON_MS = 30 * 24 * 60 * 60_000;

/**
 * The instant to record, given what the device reported.
 *
 * Returns `now` when the report is missing, unparseable, in the future beyond
 * the skew allowance, or older than the offline horizon.
 */
export function deviceTime(reportedAt: string | undefined, now = new Date()): Date {
  if (!reportedAt) return now;

  const reported = new Date(reportedAt);
  if (Number.isNaN(reported.getTime())) return now;

  const drift = reported.getTime() - now.getTime();
  if (drift > CLOCK_SKEW_MS) return now;
  if (-drift > OFFLINE_HORIZON_MS) return now;

  return reported;
}

/**
 * The instant a task ended, never before it started.
 *
 * A device whose clock jumped backwards mid-errand would otherwise produce a
 * task that ended before it began and a negative duration.
 */
export function endedNotBefore(endedAt: Date, startedAt: Date | null): Date {
  if (!startedAt) return endedAt;
  return endedAt.getTime() < startedAt.getTime() ? startedAt : endedAt;
}
