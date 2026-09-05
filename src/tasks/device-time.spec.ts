import { deviceTime, endedNotBefore } from './device-time';

describe('deviceTime', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');

  it('honours a timestamp from a few hours ago — the offline-sync case', () => {
    const reported = '2026-08-20T08:30:00.000Z';
    expect(deviceTime(reported, now).toISOString()).toBe(reported);
  });

  it('honours one from days ago, still inside the sync horizon', () => {
    const reported = '2026-08-06T17:45:00.000Z';
    expect(deviceTime(reported, now).toISOString()).toBe(reported);
  });

  it('keeps an errand in the month it happened in, not the month it synced in', () => {
    // The case that put October spend into August: an errand on the last day
    // of a month, synced the next morning.
    const lastDayOfJuly = '2026-07-31T18:20:00.000Z';
    const syncedOn = new Date('2026-08-01T09:05:00.000Z');
    expect(deviceTime(lastDayOfJuly, syncedOn).getUTCMonth()).toBe(6); // July
  });

  it('allows a little forward drift, because phone clocks are not exact', () => {
    const slightlyAhead = '2026-08-20T12:02:00.000Z';
    expect(deviceTime(slightlyAhead, now).toISOString()).toBe(slightlyAhead);
  });

  it('refuses a timestamp from the future — an errand cannot have happened yet', () => {
    expect(deviceTime('2026-10-05T10:00:00.000Z', now)).toEqual(now);
  });

  it('refuses one older than the sync horizon', () => {
    expect(deviceTime('2026-01-01T00:00:00.000Z', now)).toEqual(now);
  });

  it('falls back to server time when nothing was reported', () => {
    expect(deviceTime(undefined, now)).toEqual(now);
  });

  it('falls back when the value is not a date', () => {
    expect(deviceTime('yesterday afternoon', now)).toEqual(now);
  });
});

describe('endedNotBefore', () => {
  const started = new Date('2026-08-20T09:00:00.000Z');

  it('leaves a normal end time alone', () => {
    const ended = new Date('2026-08-20T09:45:00.000Z');
    expect(endedNotBefore(ended, started)).toEqual(ended);
  });

  it('clamps an end that precedes the start, so duration cannot go negative', () => {
    const ended = new Date('2026-08-20T08:30:00.000Z');
    expect(endedNotBefore(ended, started)).toEqual(started);
  });

  it('passes through when the task was never started', () => {
    const ended = new Date('2026-08-20T09:45:00.000Z');
    expect(endedNotBefore(ended, null)).toEqual(ended);
  });
});
