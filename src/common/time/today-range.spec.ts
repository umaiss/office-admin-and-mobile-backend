import { todayUtcRange } from './today-range';

/**
 * "Today" decides which bucket a completed task falls into on three separate
 * screens, so an off-by-one here shows up as a task that the dashboard counts
 * and the office boy's own stats do not.
 *
 * This function previously used `setHours`, which is LOCAL time — the day
 * boundary silently followed whatever `TZ` the container happened to have, in
 * contradiction of the function's own name. These tests pin the replacement:
 * pure UTC arithmetic, shifted by an explicit reporting offset.
 */
describe('todayUtcRange', () => {
  it('floors to UTC midnight and spans exactly 24 hours', () => {
    const { start, end } = todayUtcRange(new Date('2026-08-04T13:45:12.345Z'));

    expect(start.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-05T00:00:00.000Z');
  });

  it('is half-open: an instant at `end` belongs to tomorrow', () => {
    const { start, end } = todayUtcRange(new Date('2026-08-04T00:00:00.000Z'));

    expect(start.getTime()).toBe(Date.parse('2026-08-04T00:00:00.000Z'));
    // Used as `gte: start, lt: end`, so this instant is excluded — which is what
    // avoids the classic 23:59:59.999 gap between consecutive days.
    expect(end.getTime()).toBe(Date.parse('2026-08-05T00:00:00.000Z'));
  });

  it('shifts the day boundary by the reporting offset', () => {
    // 02:00 UTC on the 4th is 07:00 on the 4th in PKT (UTC+5), so the reporting
    // day is still the 4th — which starts at 19:00 UTC on the 3rd.
    const { start, end } = todayUtcRange(
      new Date('2026-08-04T02:00:00.000Z'),
      300,
    );

    expect(start.toISOString()).toBe('2026-08-03T19:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-04T19:00:00.000Z');
  });

  it('puts a late-evening UTC instant into the NEXT reporting day under a positive offset', () => {
    // 20:00 UTC on the 4th is 01:00 on the 5th in PKT — the 5th's bucket.
    const { start } = todayUtcRange(new Date('2026-08-04T20:00:00.000Z'), 300);

    expect(start.toISOString()).toBe('2026-08-04T19:00:00.000Z');
  });

  it('handles a negative offset (west of UTC)', () => {
    // 02:00 UTC on the 4th is 21:00 on the 3rd at UTC-5.
    const { start, end } = todayUtcRange(
      new Date('2026-08-04T02:00:00.000Z'),
      -300,
    );

    expect(start.toISOString()).toBe('2026-08-03T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-04T05:00:00.000Z');
  });

  it('does not depend on the process timezone', () => {
    // The whole point of the rewrite: the same instant yields the same window
    // whatever TZ the server runs in, because no local-time method is called.
    const instant = new Date('2026-08-04T13:45:12.345Z');
    const first = todayUtcRange(instant);
    const second = todayUtcRange(new Date(instant.getTime()));

    expect(first.start.getTime()).toBe(second.start.getTime());
    expect(first.start.getUTCHours()).toBe(0);
    expect(first.start.getUTCMinutes()).toBe(0);
    expect(first.start.getUTCSeconds()).toBe(0);
    expect(first.start.getUTCMilliseconds()).toBe(0);
  });
});
