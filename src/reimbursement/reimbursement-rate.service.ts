import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  decimalToNumber,
  roundCurrency,
} from '../common/serialization/decimal';
import { Prisma } from '../generated/prisma/client';
import { TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReimbursementRateDto } from './dto/create-reimbursement-rate.dto';

/** The fields returned for a rate. An allowlist, like every other select here. */
export const RATE_SELECT = {
  id: true,
  ratePerKm: true,
  effectiveFrom: true,
  note: true,
  createdAt: true,
  createdBy: { select: { id: true, name: true, email: true } },
} as const;

/** A rate row as the API returns it — `ratePerKm` as a number, not a Decimal. */
export interface RateView {
  id: string;
  ratePerKm: number;
  effectiveFrom: Date;
  note: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string; email: string } | null;
}

/** One rate's half-open window of applicability. `to === null` means "still current". */
export interface RatePeriod {
  from: Date;
  to: Date | null;
  ratePerKm: number;
}

/** What one office boy earned inside one rate period. */
export interface ReimbursementSlice {
  ratePerKm: number;
  from: Date;
  to: Date | null;
  completedTasks: number;
  distanceMeters: number;
  amount: number;
}

/** One office boy's total, and how it was arrived at. */
export interface ReimbursementTotal {
  officeBoyId: string;
  completedTasks: number;
  totalDistanceMeters: number;
  amount: number;
  breakdown: ReimbursementSlice[];
}

/** Bounds a reimbursement calculation. `to` is INCLUSIVE, matching the API. */
export interface ReimbursementWindow {
  officeBoyId?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class ReimbursementRateService {
  private readonly logger = new Logger(ReimbursementRateService.name);

  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  //  Reading rates
  // --------------------------------------------------------------------------
  /** Full rate history, newest first — the audit list on the settings screen. */
  async list(): Promise<RateView[]> {
    const rows = await this.prisma.reimbursementRate.findMany({
      select: RATE_SELECT,
      orderBy: { effectiveFrom: 'desc' },
    });
    return rows.map(toRateView);
  }

  /**
   * The rate in force at `at`, or `null` if none has been configured.
   *
   * `null` rather than a hardcoded fallback on purpose: a report that shows "no
   * rate configured" sends the admin to fix it, whereas a report that quietly
   * substitutes some default number looks correct and is not.
   */
  async current(at: Date = new Date()): Promise<RateView | null> {
    const row = await this.prisma.reimbursementRate.findFirst({
      where: { effectiveFrom: { lte: at } },
      orderBy: { effectiveFrom: 'desc' },
      select: RATE_SELECT,
    });
    return row ? toRateView(row) : null;
  }

  /**
   * The rate history folded into contiguous half-open periods.
   *
   * Each rate runs from its own `effectiveFrom` until the next one starts, and
   * the newest runs to `null` (open-ended). Because the migration seeds a rate
   * at the Unix epoch, these periods normally cover every instant that can
   * appear on a task, so no completed task is ever unpriceable.
   */
  async periods(): Promise<RatePeriod[]> {
    const rows = await this.prisma.reimbursementRate.findMany({
      orderBy: { effectiveFrom: 'asc' },
      select: { ratePerKm: true, effectiveFrom: true },
    });

    if (rows.length === 0) {
      // Only reachable on a database built with `db push` and never seeded.
      this.logger.error(
        'No reimbursement rate configured — reimbursement figures will be empty. ' +
          'Run `npm run prisma:seed` or POST /admin/reimbursement-rates.',
      );
      return [];
    }

    return rows.map((row, index) => ({
      from: row.effectiveFrom,
      to: rows[index + 1]?.effectiveFrom ?? null,
      ratePerKm: decimalToNumber(row.ratePerKm),
    }));
  }

  // --------------------------------------------------------------------------
  //  Writing rates
  // --------------------------------------------------------------------------
  /**
   * Appends a new rate. Never edits an existing one: a rate that has already
   * priced a month of work is a historical fact, and rewriting it would silently
   * restate reports that have already been read and acted on.
   *
   * `effectiveFrom` defaults to now, so the common case ("the rate is 40 from
   * today") needs no date. A future date schedules a change; a past date is
   * allowed but is a restatement, which is why the response makes the date
   * explicit and the list screen shows it.
   */
  async create(
    dto: CreateReimbursementRateDto,
    adminId: string,
  ): Promise<RateView> {
    const effectiveFrom = dto.effectiveFrom
      ? new Date(dto.effectiveFrom)
      : new Date();

    try {
      const row = await this.prisma.reimbursementRate.create({
        data: {
          ratePerKm: dto.ratePerKm,
          effectiveFrom,
          note: dto.note,
          createdById: adminId,
        },
        select: RATE_SELECT,
      });
      return toRateView(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A rate already starts at that exact instant. Pick a different effective date.',
        );
      }
      throw error;
    }
  }

  /**
   * Withdraws a rate that has not taken effect yet.
   *
   * Deleting a rate that is already in force would retroactively reprice every
   * task it covered, so that is refused — the way to change a live rate is to
   * append a new one. Scheduling a change and then thinking better of it is a
   * legitimate correction, and is the only case allowed here.
   */
  async remove(id: string): Promise<{ message: string }> {
    const rate = await this.prisma.reimbursementRate.findUnique({
      where: { id },
      select: { id: true, effectiveFrom: true },
    });

    if (!rate) {
      throw new NotFoundException('Reimbursement rate not found.');
    }

    if (rate.effectiveFrom <= new Date()) {
      throw new ConflictException(
        'This rate is already in force and has priced completed work. ' +
          'Append a new rate instead of deleting this one.',
      );
    }

    await this.prisma.reimbursementRate.delete({ where: { id } });
    return { message: 'Scheduled reimbursement rate withdrawn.' };
  }

  // --------------------------------------------------------------------------
  //  The money calculation
  // --------------------------------------------------------------------------
  /**
   * Reimbursement per office boy, priced at the rate in force when each task
   * ended.
   *
   * ## Why it is a loop over periods rather than one query
   *
   * The rate is a function of `endedAt`, so a single `groupBy(officeBoyId)`
   * cannot express it — it would have to apply one rate to the whole sum. What
   * it CAN do is answer "how far did each office boy travel between these two
   * instants", which is exactly one rate period. So: one `groupBy` per period,
   * merged in memory.
   *
   * That is a handful of queries, not N+1 — the count is the number of times an
   * admin has ever changed the rate (typically one or two), and is bounded by
   * the query window, not by the number of office boys or tasks.
   */
  async calculate(window: ReimbursementWindow): Promise<{
    periods: RatePeriod[];
    totals: Map<string, ReimbursementTotal>;
  }> {
    const periods = await this.periods();
    const totals = new Map<string, ReimbursementTotal>();

    // The API's `to` is inclusive ("up to and including this instant") while
    // period boundaries are half-open. Nudging it by a millisecond lets the
    // whole calculation below use one convention.
    const windowFrom = window.from ? new Date(window.from) : null;
    const windowTo = window.to
      ? new Date(new Date(window.to).getTime() + 1)
      : null;

    for (const period of periods) {
      const from = maxDate(period.from, windowFrom);
      const to = minDate(period.to, windowTo);

      // Empty intersection: this rate period lies entirely outside the window.
      if (to !== null && from.getTime() >= to.getTime()) {
        continue;
      }

      const where: Prisma.TaskWhereInput = {
        status: TaskStatus.COMPLETED,
        endedAt: { gte: from, ...(to ? { lt: to } : {}) },
        ...(window.officeBoyId ? { officeBoyId: window.officeBoyId } : {}),
      };

      const groupedRaw = await this.prisma.task.groupBy({
        by: ['officeBoyId'],
        where,
        _count: { _all: true },
        _sum: { distanceMeters: true },
      });

      // Prisma widens the aggregate result; this is its known runtime shape.
      const grouped = groupedRaw as unknown as {
        officeBoyId: string;
        _count: { _all: number };
        _sum: { distanceMeters: number | null };
      }[];

      for (const row of grouped) {
        const distanceMeters = row._sum.distanceMeters ?? 0;
        const amount = roundCurrency(
          (distanceMeters / 1000) * period.ratePerKm,
        );

        const total = totals.get(row.officeBoyId) ?? {
          officeBoyId: row.officeBoyId,
          completedTasks: 0,
          totalDistanceMeters: 0,
          amount: 0,
          breakdown: [],
        };

        total.completedTasks += row._count._all;
        total.totalDistanceMeters += distanceMeters;
        // Round the running total too: each slice is already a real payable
        // figure, and summing rounded slices is what the payslip will show.
        total.amount = roundCurrency(total.amount + amount);
        total.breakdown.push({
          ratePerKm: period.ratePerKm,
          from: period.from,
          to: period.to,
          completedTasks: row._count._all,
          distanceMeters,
          amount,
        });

        totals.set(row.officeBoyId, total);
      }
    }

    return { periods, totals };
  }

  /**
   * The reimbursement one office boy has earned. A thin read over `calculate`,
   * used by the office boy's own KPI screen where there is exactly one row.
   */
  async forOfficeBoy(
    officeBoyId: string,
    window: Omit<ReimbursementWindow, 'officeBoyId'> = {},
  ): Promise<ReimbursementTotal> {
    const { totals } = await this.calculate({ ...window, officeBoyId });
    return (
      totals.get(officeBoyId) ?? {
        officeBoyId,
        completedTasks: 0,
        totalDistanceMeters: 0,
        amount: 0,
        breakdown: [],
      }
    );
  }
}

/** Maps a selected row to the API view, converting `Decimal` to `number`. */
function toRateView(row: {
  id: string;
  ratePerKm: unknown;
  effectiveFrom: Date;
  note: string | null;
  createdAt: Date;
  createdBy: { id: string; name: string; email: string } | null;
}): RateView {
  return {
    id: row.id,
    ratePerKm: decimalToNumber(row.ratePerKm as never),
    effectiveFrom: row.effectiveFrom,
    note: row.note,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

/** The later of two instants; `null` on the right means "no lower bound". */
function maxDate(left: Date, right: Date | null): Date {
  return right && right.getTime() > left.getTime() ? right : left;
}

/** The earlier of two instants; `null` on either side means "unbounded". */
function minDate(left: Date | null, right: Date | null): Date | null {
  if (left === null) return right;
  if (right === null) return left;
  return left.getTime() < right.getTime() ? left : right;
}

/** Guards against a caller passing a reversed window. */
export function assertValidWindow(from?: string, to?: string): void {
  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    throw new BadRequestException('`from` must not be later than `to`.');
  }
}
