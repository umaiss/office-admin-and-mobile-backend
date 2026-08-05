import { Prisma } from '../generated/prisma/client';
import { TaskStatus } from '../generated/prisma/enums';

/**
 * Everything a caller can narrow a task list by.
 *
 * Both sides of the app filter tasks: the office boy browsing their own
 * history, and the admin browsing everyone's. They want the same filters — a
 * status, a date range, a search, whether a receipt is attached — so they share
 * one definition rather than each growing their own subtly different `where`.
 *
 * `officeBoyId` is in the shape but its ORIGIN differs and that difference is
 * the whole authorisation model: the office boy's comes from their token and
 * cannot be widened, the admin's comes from the query and may be omitted.
 * Callers set it; this builder just applies it.
 */
export interface TaskFilters {
  status?: TaskStatus;
  officeBoyId?: string;
  employeeId?: string;
  /** Inclusive lower bound on `createdAt`. */
  from?: string;
  /** Inclusive upper bound on `createdAt`. */
  to?: string;
  /** Free-text across title, description and destination. */
  search?: string;
  /** `true` = only tasks with a receipt attached, `false` = only those without. */
  hasReceipt?: boolean;
  /** `true` = only handed-in tasks, `false` = only those still outstanding. */
  submitted?: boolean;
  /**
   * A named intent, not a combinable filter: "COMPLETED, ended inside today".
   * When set it REPLACES `status` and the `from`/`to` window rather than
   * intersecting with them, because a caller asking for "completed today" and
   * also passing `status=PENDING` has asked for something contradictory, and
   * silently returning nothing would look like a data problem.
   */
  completedToday?: boolean;
  /** Supplies today's window; injected so the caller owns the timezone rule. */
  todayRange?: { start: Date; end: Date };
}

/**
 * Turns a filter set into a Prisma `where`.
 *
 * Absent filters contribute nothing — an omitted `status` must not become
 * `status: undefined` inside a nested object where Prisma would read it as a
 * real (and always-false) condition.
 */
export function buildTaskWhere(filters: TaskFilters): Prisma.TaskWhereInput {
  const scope: Prisma.TaskWhereInput = {
    ...(filters.officeBoyId ? { officeBoyId: filters.officeBoyId } : {}),
    ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    ...receiptClause(filters.hasReceipt),
    ...submittedClause(filters.submitted),
    ...searchClause(filters.search),
  };

  if (filters.completedToday && filters.todayRange) {
    return {
      ...scope,
      status: TaskStatus.COMPLETED,
      endedAt: { gte: filters.todayRange.start, lt: filters.todayRange.end },
    };
  }

  return {
    ...scope,
    ...(filters.status ? { status: filters.status } : {}),
    ...dateRangeClause('createdAt', filters.from, filters.to),
  };
}

/**
 * Case-insensitive `contains` across the free-text task fields.
 *
 * `vendorDetails` is in here because the admin's most natural petty-cash
 * question is "what did we spend at this shop" — a vendor column you cannot
 * search by is only half a feature. It costs nothing on the office boy's own
 * list, where the field is usually null.
 */
export function searchClause(search?: string): Prisma.TaskWhereInput {
  if (!search) {
    return {};
  }
  return {
    OR: [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { destination: { contains: search, mode: 'insensitive' } },
      { vendorDetails: { contains: search, mode: 'insensitive' } },
    ],
  };
}

/**
 * A range clause on a named date column, from optional ISO bounds.
 *
 * Shared by the `createdAt` window the task lists use and the `endedAt` window
 * the reimbursement and hours-saved reports use — those two report on when work
 * *finished*, not when it was created, which is the period an accountant means.
 */
export function dateRangeClause(
  field: 'createdAt' | 'endedAt' | 'submittedAt',
  from?: string,
  to?: string,
): Prisma.TaskWhereInput {
  if (!from && !to) {
    return {};
  }
  return {
    [field]: {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    },
  };
}

/**
 * Presence or absence of a receipt.
 *
 * Expressed as a relation filter rather than a column, because the receipt
 * lives in its own table. `{ isNot: null }` is Prisma's "the related row
 * exists" for an optional one-to-one.
 */
function receiptClause(hasReceipt?: boolean): Prisma.TaskWhereInput {
  if (hasReceipt === undefined) {
    return {};
  }
  return hasReceipt ? { receipt: { isNot: null } } : { receipt: { is: null } };
}

/** Handed in, or still outstanding. `submittedAt` is null until submit. */
function submittedClause(submitted?: boolean): Prisma.TaskWhereInput {
  if (submitted === undefined) {
    return {};
  }
  return submitted ? { submittedAt: { not: null } } : { submittedAt: null };
}
