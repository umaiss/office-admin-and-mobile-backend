import { Injectable } from '@nestjs/common';

import { EXPORT_ROW_CEILING } from '../common/export/excel-export.service';
import { buildPaginationMeta } from '../common/pagination/paginate';
import {
  decimalSumToNumber,
  decimalToNumber,
  roundCurrency,
} from '../common/serialization/decimal';
import { todayUtcRange } from '../common/time/today-range';
import { AppConfigService } from '../config/app-config.service';
import { Prisma } from '../generated/prisma/client';
import { Role, TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertValidWindow,
  ReimbursementRateService,
  type RatePeriod,
  type ReimbursementSlice,
} from '../reimbursement/reimbursement-rate.service';
import { buildTaskWhere, dateRangeClause } from '../tasks/task-filters';
import {
  TASK_SELECT,
  TasksService,
  toTaskResponse,
} from '../tasks/tasks.service';
import { AdminListTasksQueryDto } from './dto/admin-list-tasks-query.dto';
import { OfficeBoyStatsQueryDto } from './dto/office-boy-stats-query.dto';
import { ReceiptsQueryDto } from './dto/receipts-query.dto';
import { ReimbursementsQueryDto } from './dto/reimbursements-query.dto';

/** One office boy's reimbursement line in the admin report. */
export interface ReimbursementRow {
  officeBoyId: string;
  name: string;
  email: string;
  completedTasks: number;
  totalDistanceMeters: number;
  amount: number;
  /** How the amount splits across the rate periods it spans. */
  breakdown: ReimbursementSlice[];
}

/** One office boy's line on the statistics screen. */
export interface OfficeBoyStatsRow {
  officeBoyId: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  tasks: Record<TaskStatus, number> & { total: number };
  completedTasks: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number;
  totalAmountReceived: number;
  totalAmountReturned: number;
  netAmount: number;
  reimbursementAmount: number;
  lastTaskAt: Date | null;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    // Reused for the single-task view so the admin path and the office boy path
    // return byte-identical shapes from the same allowlist + route select.
    private readonly tasksService: TasksService,
    private readonly rates: ReimbursementRateService,
    private readonly config: AppConfigService,
  ) {}

  // --------------------------------------------------------------------------
  //  GET /admin/tasks — list all, filtered
  // --------------------------------------------------------------------------
  /**
   * Every task across every office boy, filtered and paginated.
   *
   * This is the counterpart to `TasksService.findMany`, which is hard-scoped to
   * the caller. Here nothing scopes by owner unless the admin asks for a
   * specific `officeBoyId`. Both build their `where` with the same shared
   * `buildTaskWhere`, so a filter cannot mean one thing on the office boy's
   * history screen and something else on the admin's.
   *
   * The `findMany` + `count` pair runs in one transaction so the page and the
   * total come from the same snapshot.
   */
  async listAll(query: AdminListTasksQueryDto) {
    const where = this.taskWhere(query);

    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        select: TASK_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      items: items.map(toTaskResponse),
      meta: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  // --------------------------------------------------------------------------
  //  GET /admin/tasks/:id — view any task
  // --------------------------------------------------------------------------
  /**
   * Any single task, with its route. Delegates straight to the tasks service
   * with `Role.ADMIN`, which skips the ownership check there — so there is one
   * definition of "a task with its route", not two that can drift.
   */
  findOne(taskId: string) {
    // userId is irrelevant for an admin read; the service ignores it once the
    // role is ADMIN. Pass a sentinel rather than inventing a second code path.
    return this.tasksService.findOne('', Role.ADMIN, taskId);
  }

  // --------------------------------------------------------------------------
  //  GET /admin/stats — dashboard KPIs
  // --------------------------------------------------------------------------
  /**
   * The numbers the admin dashboard header shows. All cheap aggregates, run in
   * one transaction so they describe a single consistent moment.
   */
  async stats() {
    const { start, end } = todayUtcRange(
      new Date(),
      this.config.reportTzOffsetMinutes,
    );

    const [
      byStatus,
      total,
      completedToday,
      completedTotals,
      activeOfficeBoys,
      pendingSubmissions,
      tasksWithReceipt,
    ] = await this.prisma.$transaction([
      this.prisma.task.groupBy({
        by: ['status'],
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.task.count(),
      this.prisma.task.count({
        where: {
          status: TaskStatus.COMPLETED,
          endedAt: { gte: start, lt: end },
        },
      }),
      this.prisma.task.aggregate({
        where: { status: TaskStatus.COMPLETED },
        _sum: {
          distanceMeters: true,
          durationSeconds: true,
          amountReceived: true,
          amountReturned: true,
        },
      }),
      this.prisma.user.count({
        where: { role: Role.OFFICE_BOY, isActive: true },
      }),
      // Completed but not handed in — what the admin is still waiting on before
      // the petty cash for those errands can be booked.
      this.prisma.task.count({
        where: { status: TaskStatus.COMPLETED, submittedAt: null },
      }),
      this.prisma.task.count({ where: { receipt: { isNot: null } } }),
    ]);

    // Prisma widens `_count` to a union inside a $transaction tuple; the runtime
    // shape for `_count: { _all: true }` is always `{ _all: number }`.
    const byStatusRows = byStatus as unknown as {
      status: TaskStatus;
      _count: { _all: number };
    }[];

    const totalAmountReceived = decimalSumToNumber(
      completedTotals._sum.amountReceived,
    );
    const totalAmountReturned = decimalSumToNumber(
      completedTotals._sum.amountReturned,
    );

    const currentRate = await this.rates.current();

    return {
      tasks: {
        total,
        ...this.statusCounts(
          byStatusRows.map((row) => ({
            status: row.status,
            count: row._count._all,
          })),
        ),
      },
      completedToday,
      pendingSubmissions,
      tasksWithReceipt,
      totalDistanceMeters: completedTotals._sum.distanceMeters ?? 0,
      totalDurationSeconds: completedTotals._sum.durationSeconds ?? 0,
      totalAmountReceived,
      totalAmountReturned,
      netAmount: roundCurrency(totalAmountReceived - totalAmountReturned),
      activeOfficeBoys,
      currentRatePerKm: currentRate?.ratePerKm ?? null,
    };
  }

  // --------------------------------------------------------------------------
  //  GET /admin/reimbursements — derived from completed tasks
  // --------------------------------------------------------------------------
  /**
   * Reimbursement per office boy, derived on the fly: distance covered on
   * COMPLETED tasks, converted to kilometres, times the rate that was in force
   * when each task ended. No `Reimbursement` table exists — the figure is always
   * recomputed from the authoritative distances and the rate history, so it
   * cannot fall out of step with either.
   *
   * The per-period arithmetic lives in `ReimbursementRateService.calculate`,
   * shared with the office boy's own KPI screen so the two can never quote
   * different numbers for the same work. All this adds is display identity,
   * fetched in a single `user.findMany` rather than one lookup per group.
   */
  async reimbursements(query: ReimbursementsQueryDto): Promise<{
    currentRatePerKm: number | null;
    rates: RatePeriod[];
    rows: ReimbursementRow[];
    totalAmount: number;
  }> {
    assertValidWindow(query.from, query.to);

    const [{ periods, totals }, currentRate] = await Promise.all([
      this.rates.calculate(query),
      this.rates.current(),
    ]);

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...totals.keys()] } },
      select: { id: true, name: true, email: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    const rows: ReimbursementRow[] = [...totals.values()].map((total) => {
      const user = userById.get(total.officeBoyId);
      return {
        officeBoyId: total.officeBoyId,
        name: user?.name ?? '(unknown)',
        email: user?.email ?? '',
        completedTasks: total.completedTasks,
        totalDistanceMeters: total.totalDistanceMeters,
        amount: total.amount,
        breakdown: total.breakdown,
      };
    });

    // Highest payout first — the order an admin scanning the report wants.
    rows.sort((a, b) => b.amount - a.amount);

    return {
      currentRatePerKm: currentRate?.ratePerKm ?? null,
      rates: periods,
      rows,
      totalAmount: roundCurrency(
        rows.reduce((sum, row) => sum + row.amount, 0),
      ),
    };
  }

  // --------------------------------------------------------------------------
  //  GET /admin/office-boys/stats — per-person performance
  // --------------------------------------------------------------------------
  /**
   * One row per office boy: what they have outstanding, what they have finished,
   * how far and how long, what cash passed through their hands, and what they
   * are owed.
   *
   * Four queries regardless of headcount, not one per person: a `groupBy` on
   * (officeBoyId, status) for the counts, a `groupBy` on officeBoyId for the
   * completed totals, one `user.findMany` for identity, and the shared
   * reimbursement calculation. Office boys with no tasks at all still appear —
   * a zero row is information ("this person did nothing this month"), whereas
   * their absence looks like a missing record.
   */
  async officeBoyStats(
    query: OfficeBoyStatsQueryDto,
    officeBoyId?: string,
  ): Promise<{ rows: OfficeBoyStatsRow[]; totals: OfficeBoyStatsTotals }> {
    assertValidWindow(query.from, query.to);

    const scope = officeBoyId ? { officeBoyId } : {};
    const window = dateRangeClause('endedAt', query.from, query.to);

    const [byStatusRaw, completedRaw, users, reimbursement] = await Promise.all(
      [
        this.prisma.task.groupBy({
          by: ['officeBoyId', 'status'],
          where: scope,
          _count: { _all: true },
        }),
        this.prisma.task.groupBy({
          by: ['officeBoyId'],
          where: { ...scope, status: TaskStatus.COMPLETED, ...window },
          _count: { _all: true },
          _sum: {
            distanceMeters: true,
            durationSeconds: true,
            amountReceived: true,
            amountReturned: true,
          },
          _avg: { durationSeconds: true },
          _max: { endedAt: true },
        }),
        this.prisma.user.findMany({
          where: {
            role: Role.OFFICE_BOY,
            ...(officeBoyId ? { id: officeBoyId } : {}),
          },
          select: {
            id: true,
            name: true,
            email: true,
            isActive: true,
            lastLoginAt: true,
          },
          orderBy: { name: 'asc' },
        }),
        this.rates.calculate({ ...query, officeBoyId }),
      ],
    );

    // Narrow Prisma's widened aggregate unions to their known runtime shapes.
    const byStatus = byStatusRaw as unknown as {
      officeBoyId: string;
      status: TaskStatus;
      _count: { _all: number };
    }[];
    const completed = completedRaw as unknown as {
      officeBoyId: string;
      _count: { _all: number };
      _sum: {
        distanceMeters: number | null;
        durationSeconds: number | null;
        amountReceived: unknown;
        amountReturned: unknown;
      };
      _avg: { durationSeconds: number | null };
      _max: { endedAt: Date | null };
    }[];

    const statusByOfficeBoy = new Map<string, Record<TaskStatus, number>>();
    for (const row of byStatus) {
      const counts =
        statusByOfficeBoy.get(row.officeBoyId) ?? emptyStatusCounts();
      counts[row.status] = row._count._all;
      statusByOfficeBoy.set(row.officeBoyId, counts);
    }
    const completedById = new Map(
      completed.map((row) => [row.officeBoyId, row]),
    );

    const rows: OfficeBoyStatsRow[] = users.map((user) => {
      const counts = statusByOfficeBoy.get(user.id) ?? emptyStatusCounts();
      const agg = completedById.get(user.id);
      const totalAmountReceived = decimalSumToNumber(
        agg?._sum.amountReceived as never,
      );
      const totalAmountReturned = decimalSumToNumber(
        agg?._sum.amountReturned as never,
      );

      return {
        officeBoyId: user.id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        tasks: {
          total: Object.values(counts).reduce((sum, count) => sum + count, 0),
          ...counts,
        },
        completedTasks: agg?._count._all ?? 0,
        totalDistanceMeters: agg?._sum.distanceMeters ?? 0,
        totalDurationSeconds: agg?._sum.durationSeconds ?? 0,
        averageDurationSeconds: Math.round(agg?._avg.durationSeconds ?? 0),
        totalAmountReceived,
        totalAmountReturned,
        netAmount: roundCurrency(totalAmountReceived - totalAmountReturned),
        reimbursementAmount: reimbursement.totals.get(user.id)?.amount ?? 0,
        lastTaskAt: agg?._max.endedAt ?? null,
      };
    });

    return { rows, totals: sumOfficeBoyStats(rows) };
  }

  // --------------------------------------------------------------------------
  //  GET /admin/receipts — the petty cash feed
  // --------------------------------------------------------------------------
  /**
   * Completed tasks with their settlement details and receipt, for booking into
   * petty cash expenses.
   *
   * Scoped to COMPLETED because an unfinished errand has no expense to book. The
   * receipt's METADATA is returned along with a `receiptUrl`; the bytes are
   * fetched separately through the authorised download route, so a large list
   * stays a small response.
   *
   * Ordered by `submittedAt` descending with nulls last, so the queue an admin
   * actually works — most recently handed in first — is the default view.
   */
  async receipts(query: ReceiptsQueryDto) {
    assertValidWindow(query.from, query.to);

    const where: Prisma.TaskWhereInput = {
      status: TaskStatus.COMPLETED,
      ...(query.officeBoyId ? { officeBoyId: query.officeBoyId } : {}),
      ...dateRangeClause('endedAt', query.from, query.to),
      ...(query.hasReceipt === undefined
        ? {}
        : query.hasReceipt
          ? { receipt: { isNot: null } }
          : { receipt: { is: null } }),
      ...(query.submitted === undefined
        ? {}
        : query.submitted
          ? { submittedAt: { not: null } }
          : { submittedAt: null }),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: [
          { submittedAt: { sort: 'desc', nulls: 'last' } },
          { endedAt: 'desc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          title: true,
          description: true,
          destination: true,
          endedAt: true,
          submittedAt: true,
          amountReceived: true,
          amountReturned: true,
          vendorDetails: true,
          distanceMeters: true,
          durationSeconds: true,
          officeBoy: { select: { id: true, name: true, email: true } },
          employee: { select: { id: true, name: true, department: true } },
          receipt: {
            select: {
              id: true,
              originalName: true,
              mimeType: true,
              sizeBytes: true,
              uploadedAt: true,
            },
          },
        },
      }),
      this.prisma.task.count({ where }),
    ]);

    const items = rows.map((row) => {
      const amountReceived = decimalToNumber(row.amountReceived) ?? 0;
      const amountReturned = decimalToNumber(row.amountReturned) ?? 0;

      return {
        ...row,
        amountReceived,
        amountReturned,
        // What the errand actually cost — the figure that goes into the petty
        // cash ledger, computed here so three clients do not each derive it.
        netAmount: roundCurrency(amountReceived - amountReturned),
        // A ready-to-use link rather than making the dashboard assemble one from
        // the task id. Null when there is nothing to download.
        receiptUrl: row.receipt ? `/api/v1/tasks/${row.id}/receipt` : null,
      };
    });

    const settlementTotals = await this.prisma.task.aggregate({
      where,
      _sum: { amountReceived: true, amountReturned: true },
    });
    const sumReceived = decimalSumToNumber(
      settlementTotals._sum.amountReceived,
    );
    const sumReturned = decimalSumToNumber(
      settlementTotals._sum.amountReturned,
    );

    return {
      items,
      // Totals across the WHOLE filtered set, not just this page — an admin
      // reconciling a month needs the month's figure, not page 3 of it.
      totals: {
        totalAmountReceived: sumReceived,
        totalAmountReturned: sumReturned,
        netAmount: roundCurrency(sumReceived - sumReturned),
      },
      meta: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  // --------------------------------------------------------------------------
  //  Export source data
  // --------------------------------------------------------------------------
  /**
   * The rows the xlsx task export writes, using the same filters as `listAll`
   * but with no pagination and a hard ceiling. Includes the office boy's
   * name/email (joined) because a spreadsheet read by a human needs a name, not
   * just an id.
   *
   * The ceiling exists so a filterless export cannot try to build a workbook of
   * millions of rows. If it bites, the caller is told via `truncated`.
   */
  async tasksForExport(query: AdminListTasksQueryDto): Promise<{
    rows: TaskExportRow[];
    truncated: boolean;
  }> {
    const where = this.taskWhere(query);

    const rows = await this.prisma.task.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CEILING + 1,
      select: {
        id: true,
        title: true,
        status: true,
        destination: true,
        distanceMeters: true,
        durationSeconds: true,
        amountReceived: true,
        amountReturned: true,
        vendorDetails: true,
        submittedAt: true,
        cancellationReason: true,
        createdAt: true,
        startedAt: true,
        endedAt: true,
        cancelledAt: true,
        officeBoy: { select: { name: true, email: true } },
        employee: { select: { name: true, department: true } },
        receipt: { select: { originalName: true, uploadedAt: true } },
      },
    });

    const truncated = rows.length > EXPORT_ROW_CEILING;
    return {
      rows: (truncated ? rows.slice(0, EXPORT_ROW_CEILING) : rows).map(
        (row) => ({
          ...row,
          amountReceived: decimalToNumber(row.amountReceived as never) ?? 0,
          amountReturned: decimalToNumber(row.amountReturned as never) ?? 0,
        }),
      ),
      truncated,
    };
  }

  // --------------------------------------------------------------------------
  //  Internals
  // --------------------------------------------------------------------------
  /**
   * The admin list/export `where`, built from the shared filter logic with the
   * reporting day supplied for the `completedToday` shortcut. Injecting the
   * range here rather than reaching for it inside `buildTaskWhere` keeps the
   * timezone decision in the layer that has the config.
   */
  private taskWhere(query: AdminListTasksQueryDto): Prisma.TaskWhereInput {
    return buildTaskWhere({
      ...query,
      todayRange: query.completedToday
        ? todayUtcRange(new Date(), this.config.reportTzOffsetMinutes)
        : undefined,
    });
  }

  /**
   * Flattens the `groupBy(status)` result into one field per status, defaulting
   * any absent status to 0 so the dashboard always sees all four keys.
   */
  private statusCounts(
    grouped: { status: TaskStatus; count: number }[],
  ): Record<TaskStatus, number> {
    const counts = emptyStatusCounts();
    for (const row of grouped) {
      counts[row.status] = row.count;
    }
    return counts;
  }
}

/** Fleet-wide sums under the office boy statistics table. */
export interface OfficeBoyStatsTotals {
  officeBoys: number;
  completedTasks: number;
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  totalAmountReceived: number;
  totalAmountReturned: number;
  netAmount: number;
  reimbursementAmount: number;
}

/** Sums the per-person rows so the table and its footer cannot disagree. */
function sumOfficeBoyStats(rows: OfficeBoyStatsRow[]): OfficeBoyStatsTotals {
  const totalAmountReceived = roundCurrency(
    rows.reduce((sum, row) => sum + row.totalAmountReceived, 0),
  );
  const totalAmountReturned = roundCurrency(
    rows.reduce((sum, row) => sum + row.totalAmountReturned, 0),
  );

  return {
    officeBoys: rows.length,
    completedTasks: rows.reduce((sum, row) => sum + row.completedTasks, 0),
    totalDistanceMeters: rows.reduce(
      (sum, row) => sum + row.totalDistanceMeters,
      0,
    ),
    totalDurationSeconds: rows.reduce(
      (sum, row) => sum + row.totalDurationSeconds,
      0,
    ),
    totalAmountReceived,
    totalAmountReturned,
    netAmount: roundCurrency(totalAmountReceived - totalAmountReturned),
    reimbursementAmount: roundCurrency(
      rows.reduce((sum, row) => sum + row.reimbursementAmount, 0),
    ),
  };
}

/** A zero-filled count per status, so every consumer sees all four keys. */
function emptyStatusCounts(): Record<TaskStatus, number> {
  return {
    [TaskStatus.PENDING]: 0,
    [TaskStatus.IN_PROGRESS]: 0,
    [TaskStatus.COMPLETED]: 0,
    [TaskStatus.CANCELLED]: 0,
  };
}

/** One task row as the export query selects it, with money already normalised. */
export interface TaskExportRow {
  id: string;
  title: string | null;
  status: TaskStatus;
  destination: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  amountReceived: number;
  amountReturned: number;
  vendorDetails: string | null;
  submittedAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  cancelledAt: Date | null;
  officeBoy: { name: string; email: string };
  employee: { name: string; department: string | null } | null;
  receipt: { originalName: string; uploadedAt: Date } | null;
}

// Re-exported so existing importers of `EXPORT_ROW_CEILING` from this module
// keep working now that the constant lives with the export machinery.
export { EXPORT_ROW_CEILING };
