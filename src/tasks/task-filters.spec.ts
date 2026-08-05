import { TaskStatus } from '../generated/prisma/enums';
import { buildTaskWhere, dateRangeClause } from './task-filters';

/**
 * Both the office boy's history screen and the admin's task list build their
 * Prisma `where` here, which is the point: a filter must not mean one thing on
 * one screen and something else on the other. These tests pin the parts that are
 * easy to get subtly wrong — that an absent filter contributes NOTHING (rather
 * than a `field: undefined` Prisma would read as a real condition), and that
 * `completedToday` replaces the status/date filters rather than intersecting
 * with them.
 */
describe('buildTaskWhere', () => {
  const TODAY = {
    start: new Date('2026-08-04T00:00:00.000Z'),
    end: new Date('2026-08-05T00:00:00.000Z'),
  };

  it('produces an empty where when nothing is filtered', () => {
    expect(buildTaskWhere({})).toEqual({});
  });

  it('omits absent filters entirely rather than setting them to undefined', () => {
    const where = buildTaskWhere({ status: TaskStatus.PENDING });

    expect(where).toEqual({ status: TaskStatus.PENDING });
    expect(where).not.toHaveProperty('officeBoyId');
    expect(where).not.toHaveProperty('employeeId');
    expect(where).not.toHaveProperty('receipt');
  });

  it('scopes to an office boy and an employee when both are given', () => {
    const where = buildTaskWhere({ officeBoyId: 'ob1', employeeId: 'e1' });

    expect(where).toMatchObject({ officeBoyId: 'ob1', employeeId: 'e1' });
  });

  it('expands search into a case-insensitive OR across every free-text field', () => {
    const where = buildTaskWhere({ search: 'bank' });

    expect(where.OR).toEqual([
      { title: { contains: 'bank', mode: 'insensitive' } },
      { description: { contains: 'bank', mode: 'insensitive' } },
      { destination: { contains: 'bank', mode: 'insensitive' } },
      // The admin's real petty-cash question is "what did we spend at this
      // shop", so the vendor has to be searchable or the column is half a
      // feature.
      { vendorDetails: { contains: 'bank', mode: 'insensitive' } },
    ]);
  });

  it('expresses hasReceipt as a relation filter, since the receipt is its own table', () => {
    expect(buildTaskWhere({ hasReceipt: true }).receipt).toEqual({
      isNot: null,
    });
    expect(buildTaskWhere({ hasReceipt: false }).receipt).toEqual({ is: null });
  });

  it('distinguishes submitted=false from submitted being absent', () => {
    expect(buildTaskWhere({ submitted: false }).submittedAt).toBeNull();
    expect(buildTaskWhere({ submitted: true }).submittedAt).toEqual({
      not: null,
    });
    expect(buildTaskWhere({})).not.toHaveProperty('submittedAt');
  });

  it('builds a createdAt range from the date bounds', () => {
    const where = buildTaskWhere({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    });

    expect(where.createdAt).toEqual({
      gte: new Date('2026-08-01T00:00:00.000Z'),
      lte: new Date('2026-08-31T23:59:59.999Z'),
    });
  });

  describe('completedToday', () => {
    it('pins status to COMPLETED and the endedAt window, overriding a supplied status', () => {
      const where = buildTaskWhere({
        completedToday: true,
        status: TaskStatus.PENDING, // contradictory — must be replaced, not merged
        from: '2020-01-01T00:00:00.000Z',
        todayRange: TODAY,
      });

      expect(where.status).toBe(TaskStatus.COMPLETED);
      expect(where.endedAt).toEqual({ gte: TODAY.start, lt: TODAY.end });
      // The supplied createdAt window is discarded, not intersected.
      expect(where).not.toHaveProperty('createdAt');
    });

    it('keeps the scoping filters, which are not contradicted by the shortcut', () => {
      const where = buildTaskWhere({
        completedToday: true,
        officeBoyId: 'ob1',
        search: 'bank',
        todayRange: TODAY,
      });

      expect(where.officeBoyId).toBe('ob1');
      expect(where.OR).toHaveLength(4);
    });

    it('falls through to the normal branch when no day window was supplied', () => {
      // The caller owns the timezone rule, so without a range there is no
      // defensible "today" to filter on — better the ordinary filters than a
      // silently wrong day.
      const where = buildTaskWhere({
        completedToday: true,
        status: TaskStatus.PENDING,
      });

      expect(where.status).toBe(TaskStatus.PENDING);
      expect(where).not.toHaveProperty('endedAt');
    });
  });
});

describe('dateRangeClause', () => {
  it('returns nothing when both bounds are absent', () => {
    expect(dateRangeClause('endedAt')).toEqual({});
  });

  it('supports a one-sided bound', () => {
    expect(dateRangeClause('endedAt', '2026-08-01T00:00:00.000Z')).toEqual({
      endedAt: { gte: new Date('2026-08-01T00:00:00.000Z') },
    });
    expect(
      dateRangeClause('endedAt', undefined, '2026-08-31T00:00:00.000Z'),
    ).toEqual({ endedAt: { lte: new Date('2026-08-31T00:00:00.000Z') } });
  });

  it('targets whichever column it is asked for', () => {
    expect(
      dateRangeClause('submittedAt', '2026-08-01T00:00:00.000Z'),
    ).toHaveProperty('submittedAt');
  });
});
