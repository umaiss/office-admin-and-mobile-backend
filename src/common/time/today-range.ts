/** A day is exactly this many milliseconds — no DST inside a fixed offset. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/**
 * The UTC instant range covering "today" for reporting purposes.
 *
 * Several views need a "today" window — the admin dashboard's "completed today"
 * figure, the office boy's own stats, and the `completedToday` list filter.
 * Computing it in one place keeps the definition identical across all of them;
 * an off-by-one on the day boundary otherwise makes a task counted in one view
 * and missing from another.
 *
 * ## Which "today"
 *
 * `offsetMinutes` is how far the reporting day sits ahead of UTC, from
 * `REPORT_TZ_OFFSET_MINUTES`. Pass 300 and the day runs 00:00–24:00 Pakistan
 * time; pass 0 (the default) and it runs in UTC.
 *
 * This used to be computed with `setHours`, which is *local* time — the day
 * boundary silently followed whatever `TZ` the container happened to have. That
 * made the answer depend on deployment configuration rather than on a business
 * decision, and it disagreed with this function's own name. The arithmetic below
 * is pure UTC: shift into the reporting zone, floor to a day, shift back.
 *
 * Returned as a half-open `[start, end)` — `start` inclusive, `end` exclusive —
 * which is the shape Prisma's `gte`/`lt` want and which avoids the classic
 * "23:59:59.999 vs 00:00:00.000 next day" gap.
 */
export function todayUtcRange(
  now: Date = new Date(),
  offsetMinutes = 0,
): { start: Date; end: Date } {
  const offsetMs = offsetMinutes * MS_PER_MINUTE;

  // Move the instant into the reporting zone, floor it to a whole day there,
  // then move the boundary back to the real UTC instant it corresponds to.
  const shifted = now.getTime() + offsetMs;
  const dayStartShifted = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY;

  const start = new Date(dayStartShifted - offsetMs);
  const end = new Date(start.getTime() + MS_PER_DAY);

  return { start, end };
}
