import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { buildPaginationMeta } from '../common/pagination/paginate';
import { dateRangeClause } from '../tasks/task-filters';
import { Prisma } from '../generated/prisma/client';
import { TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { HoursSavedQueryDto } from './dto/hours-saved-query.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

/**
 * The fields returned for an employee.
 *
 * An allowlist, like `PUBLIC_USER_SELECT` and `TASK_SELECT` — a column can only
 * ever be exposed by being added here on purpose. There are no secrets on an
 * Employee today, but the discipline keeps that true if one is ever added.
 */
export const EMPLOYEE_SELECT = {
  id: true,
  name: true,
  department: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** One employee's line on the "Top 10 — Hours Saved" tab. */
export interface HoursSavedRow {
  employeeId: string;
  name: string;
  department: string | null;
  isActive: boolean;
  completedTasks: number;
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  hoursSaved: number;
}

/** The collective figures under the per-employee table. */
export interface HoursSavedTotals {
  employees: number;
  completedTasks: number;
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  totalHoursSaved: number;
}

/**
 * The most employees that may be active at once — the "Top 10" in the name,
 * enforced rather than aspirational.
 *
 * Deactivating one frees a slot; the deactivated employee keeps every historical
 * task and stays on the hours-saved report, because the cap is about who can
 * receive NEW errands, not about erasing what already happened.
 */
export const MAX_ACTIVE_EMPLOYEES = 10;

/** Rounds hours to 2 decimal places, avoiding float drift. */
function roundHours(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  // --------------------------------------------------------------------------
  //  POST /employees (admin)
  // --------------------------------------------------------------------------
  /**
   * Adds an employee, provided there is a free slot in the Top 10.
   *
   * ## Why the count and the insert share a transaction
   *
   * Two admins adding the tenth and eleventh employee at the same moment would
   * both read "9 active" and both insert, leaving 11. `Serializable` makes
   * Postgres detect that the two transactions cannot be ordered consistently and
   * abort one of them, which is the only way to enforce a cap that is a count
   * rather than a uniqueness constraint. The alternative — a check constraint —
   * cannot express "count rows in this table".
   */
  create(dto: CreateEmployeeDto) {
    return this.prisma.$transaction(
      async (tx) => {
        const active = await tx.employee.count({ where: { isActive: true } });
        assertSlotAvailable(active);

        return tx.employee.create({
          data: { name: dto.name, department: dto.department },
          select: EMPLOYEE_SELECT,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  // --------------------------------------------------------------------------
  //  GET /employees — directory (admin) / dropdown source (office boy)
  // --------------------------------------------------------------------------
  /**
   * A paginated, filterable page of employees. The `findMany` + `count` pair
   * runs in one transaction so the page and the total describe the same
   * snapshot, exactly as the user and task lists do.
   *
   * The office-boy dropdown calls this with `isActive` forced true by the
   * controller; an admin may pass any filter.
   */
  async findMany(query: ListEmployeesQueryDto) {
    const where: Prisma.EmployeeWhereInput = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...this.searchClause(query.search),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.employee.findMany({
        where,
        select: EMPLOYEE_SELECT,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.employee.count({ where }),
    ]);

    return {
      items,
      meta: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  // --------------------------------------------------------------------------
  //  GET /employees/hours-saved — the Top 10 tab
  // --------------------------------------------------------------------------
  /**
   * Employees ranked by the time office boys have spent on their COMPLETED
   * tasks. "Hours saved" is that total task time expressed in hours — the hours
   * the employee did not have to spend running the errand themselves.
   *
   * Two queries, not N+1: one `groupBy` for the sums, then a single
   * `employee.findMany` to attach names to the ids it returned — the same shape
   * as `AdminService.reimbursements`. Cancelled/pending/in-progress tasks are
   * excluded because only completed work has a settled `durationSeconds`.
   *
   * No `take: 10` here. The cap on ACTIVE employees is enforced at the point of
   * creation, so the list is naturally small; and truncating the report would
   * hide deactivated employees whose historical hours are exactly what a
   * year-end summary is asking about.
   */
  async hoursSaved(
    query: HoursSavedQueryDto = {},
  ): Promise<{ rows: HoursSavedRow[]; totals: HoursSavedTotals }> {
    const groupedRaw = await this.prisma.task.groupBy({
      by: ['employeeId'],
      where: {
        status: TaskStatus.COMPLETED,
        employeeId: { not: null },
        ...dateRangeClause('endedAt', query.from, query.to),
      },
      _count: { _all: true },
      _sum: { durationSeconds: true, distanceMeters: true },
      orderBy: { _sum: { durationSeconds: 'desc' } },
    });

    // Narrow Prisma's widened aggregate union to its known runtime shape. The
    // `not: null` filter guarantees every `employeeId` here is a string.
    const grouped = groupedRaw as unknown as {
      employeeId: string;
      _count: { _all: number };
      _sum: { durationSeconds: number | null; distanceMeters: number | null };
    }[];

    const employeeIds = grouped.map((g) => g.employeeId);
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, name: true, department: true, isActive: true },
    });
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    const rows: HoursSavedRow[] = grouped.map((g) => {
      const employee = employeeById.get(g.employeeId);
      const totalDurationSeconds = g._sum.durationSeconds ?? 0;
      return {
        employeeId: g.employeeId,
        // An employee row can only vanish by being hard-deleted, which is only
        // allowed when they have no tasks — so this fallback should be
        // unreachable. It exists so a stale row can never crash the report.
        name: employee?.name ?? '(unknown)',
        department: employee?.department ?? null,
        isActive: employee?.isActive ?? false,
        completedTasks: g._count._all,
        totalDurationSeconds,
        totalDistanceMeters: g._sum.distanceMeters ?? 0,
        hoursSaved: roundHours(totalDurationSeconds / 3600),
      };
    });

    // Summed from the rows rather than re-queried: the two would otherwise be
    // separate reads that could disagree, and a table whose total does not match
    // its own column is the kind of thing that destroys trust in a report.
    const totalDurationSeconds = rows.reduce(
      (sum, row) => sum + row.totalDurationSeconds,
      0,
    );

    return {
      rows,
      totals: {
        employees: rows.length,
        completedTasks: rows.reduce((sum, row) => sum + row.completedTasks, 0),
        totalDurationSeconds,
        totalDistanceMeters: rows.reduce(
          (sum, row) => sum + row.totalDistanceMeters,
          0,
        ),
        totalHoursSaved: roundHours(totalDurationSeconds / 3600),
      },
    };
  }

  // --------------------------------------------------------------------------
  //  GET /employees/:id/stats (admin)
  // --------------------------------------------------------------------------
  /**
   * One employee's complete picture: how their errands broke down by status,
   * how much time and distance they represent, and when the first and last one
   * happened.
   *
   * The `_min`/`_max` on `endedAt` are what let the dashboard say "served since
   * March" without loading every task to find the earliest.
   */
  async employeeStats(id: string, query: HoursSavedQueryDto = {}) {
    const employee = await this.findByIdOrThrow(id);
    const window = dateRangeClause('endedAt', query.from, query.to);

    const [byStatus, completed] = await this.prisma.$transaction([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { employeeId: id },
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.task.aggregate({
        where: { employeeId: id, status: TaskStatus.COMPLETED, ...window },
        _count: { _all: true },
        _sum: { durationSeconds: true, distanceMeters: true },
        _avg: { durationSeconds: true },
        _min: { endedAt: true },
        _max: { endedAt: true },
      }),
    ]);

    // Prisma widens `_count` inside a $transaction tuple; this is its runtime shape.
    const byStatusRows = byStatus as unknown as {
      status: TaskStatus;
      _count: { _all: number };
    }[];

    const counts: Record<TaskStatus, number> = {
      [TaskStatus.PENDING]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };
    for (const row of byStatusRows) {
      counts[row.status] = row._count._all;
    }

    const totalDurationSeconds = completed._sum.durationSeconds ?? 0;

    return {
      employee,
      tasks: {
        total: Object.values(counts).reduce((sum, count) => sum + count, 0),
        ...counts,
      },
      completedTasks: completed._count._all,
      totalDurationSeconds,
      totalDistanceMeters: completed._sum.distanceMeters ?? 0,
      averageDurationSeconds: Math.round(completed._avg.durationSeconds ?? 0),
      hoursSaved: roundHours(totalDurationSeconds / 3600),
      firstTaskAt: completed._min.endedAt,
      lastTaskAt: completed._max.endedAt,
    };
  }

  // --------------------------------------------------------------------------
  //  GET /employees/:id (admin)
  // --------------------------------------------------------------------------
  /**
   * One employee, or a 404.
   *
   * This used to return `null` for an unknown id, which the controller then
   * wrapped into `200 { data: null }` — contradicting its own documented 404 and
   * leaving every client to invent its own "was that a miss or an empty record?"
   * check. Throwing here makes the documented behaviour the real behaviour.
   */
  async findByIdOrThrow(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      select: EMPLOYEE_SELECT,
    });

    if (!employee) {
      throw new NotFoundException('Employee not found.');
    }

    return employee;
  }

  // --------------------------------------------------------------------------
  //  PATCH /employees/:id (admin)
  // --------------------------------------------------------------------------
  /**
   * Updates the mutable profile fields (name/department). `isActive` is not here
   * by design — it has its own explicit `/activate` and `/deactivate` routes.
   * Prisma throws P2025 when the id does not exist; we translate that into a
   * clean 404, exactly as the users service does.
   */
  async update(id: string, dto: UpdateEmployeeDto) {
    try {
      return await this.prisma.employee.update({
        where: { id },
        data: dto,
        select: EMPLOYEE_SELECT,
      });
    } catch (error) {
      this.notFoundOrRethrow(error);
    }
  }

  // --------------------------------------------------------------------------
  //  POST /employees/:id/activate · /deactivate (admin)
  // --------------------------------------------------------------------------
  /**
   * Flips the soft-delete flag. A deactivated employee drops out of the office
   * boy's dropdown (and cannot be linked to a new task — the tasks service
   * checks `isActive`), while their historical tasks and hours-saved totals
   * remain intact.
   */
  async setActive(id: string, isActive: boolean) {
    await this.prisma
      .$transaction(
        async (tx) => {
          // Activating consumes a slot, so it has to respect the cap too —
          // otherwise deactivating one employee and reactivating two would walk
          // straight past a limit that only `create` was checking.
          if (isActive) {
            const current = await tx.employee.findUnique({
              where: { id },
              select: { isActive: true },
            });

            if (!current) {
              throw new NotFoundException('Employee not found.');
            }

            // Re-activating someone who is already active is a no-op, not a
            // reason to reject — they are already occupying their own slot.
            if (!current.isActive) {
              const active = await tx.employee.count({
                where: { isActive: true },
              });
              assertSlotAvailable(active);
            }
          }

          await tx.employee.update({
            where: { id },
            data: { isActive },
            select: { id: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
      .catch((error: unknown) => {
        if (error instanceof NotFoundException) throw error;
        if (error instanceof ConflictException) throw error;
        this.notFoundOrRethrow(error);
      });

    // Re-read through the allowlist so the response shape matches every other
    // employee endpoint exactly.
    return this.findByIdOrThrow(id);
  }

  // --------------------------------------------------------------------------
  //  DELETE /employees/:id (admin)
  // --------------------------------------------------------------------------
  /**
   * Permanently removes an employee who was never used.
   *
   * An employee with tasks CANNOT be deleted, and that is the point: their tasks
   * are the raw material of the hours-saved report, and `onDelete: Restrict` on
   * the foreign key means the database would refuse anyway. Deleting them by
   * nulling the links would quietly reclassify historical errands as generic
   * office tasks and make last quarter's report change its mind.
   *
   * So this exists for the genuine case — a typo'd name added five minutes ago —
   * and everything else is told to deactivate instead.
   *
   * The count is checked first so the message can say HOW MANY tasks are in the
   * way, which is what the admin needs to decide. The FK is still the real
   * guarantee: a task created between the count and the delete makes Postgres
   * raise P2003, which lands on the same 409.
   */
  async remove(id: string): Promise<{ message: string }> {
    await this.findByIdOrThrow(id);

    const linkedTasks = await this.prisma.task.count({
      where: { employeeId: id },
    });

    if (linkedTasks > 0) {
      throw new ConflictException(
        `Employee has ${linkedTasks} linked task(s) and cannot be deleted. ` +
          'Deactivate them instead — their history and hours saved are preserved.',
      );
    }

    try {
      await this.prisma.employee.delete({ where: { id } });
    } catch (error) {
      this.notFoundOrRethrow(error);
    }

    return { message: 'Employee deleted.' };
  }

  /** Case-insensitive contains across name and department. */
  private searchClause(search?: string): Prisma.EmployeeWhereInput {
    if (!search) {
      return {};
    }
    return {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { department: { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  /**
   * Maps Prisma's error codes onto the right HTTP status; rethrows anything else.
   *
   * P2025 ("record not found") is a 404. P2003 ("foreign key constraint failed")
   * only reaches here from `remove`, and means a task was linked to this
   * employee between the count and the delete — the same situation the explicit
   * check reports, so it gets the same 409 rather than surfacing as a 500.
   */
  private notFoundOrRethrow(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') {
        throw new NotFoundException('Employee not found.');
      }
      if (error.code === 'P2003') {
        throw new ConflictException(
          'Employee now has linked tasks and cannot be deleted. Deactivate them instead.',
        );
      }
    }
    throw error;
  }
}

/** Rejects the write when the Top 10 is already full. */
function assertSlotAvailable(activeCount: number): void {
  if (activeCount >= MAX_ACTIVE_EMPLOYEES) {
    throw new ConflictException(
      `At most ${MAX_ACTIVE_EMPLOYEES} employees may be active at once. ` +
        'Deactivate one before adding or activating another.',
    );
  }
}
