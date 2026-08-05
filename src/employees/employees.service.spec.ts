import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { callArg, firstArg } from '../common/testing/mock-args';
import { Prisma } from '../generated/prisma/client';
import { TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeesService, MAX_ACTIVE_EMPLOYEES } from './employees.service';

/**
 * These tests pin the employee-directory behaviour the database cannot enforce:
 * how the list query becomes a Prisma `where` (the isActive filter and the
 * name/department search OR), the pagination meta math, the P2025 → 404 and
 * P2003 → 409 translations, the ten-active cap on BOTH create and activate, the
 * refusal to delete an employee with history, and the "hours saved" report —
 * that it aggregates only COMPLETED tasks, ranks by time, attaches names without
 * an N+1, and rounds seconds to hours correctly.
 *
 * Prisma is fully mocked. `$transaction` handles both forms the service uses:
 * an array of promises (the list + count pair) and a callback (the cap checks,
 * which need the count and the write to be atomic).
 */
describe('EmployeesService', () => {
  let service: EmployeesService;
  let prisma: {
    employee: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    task: {
      groupBy: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      employee: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      task: {
        groupBy: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn(),
      },
      $transaction: jest.fn((ops: unknown) =>
        Array.isArray(ops)
          ? Promise.all(ops as Promise<unknown>[])
          : // Callback form: hand the callback the same mock client, which is
            // what an interactive Prisma transaction does.
            (ops as (tx: unknown) => unknown)(prisma),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<EmployeesService>(EmployeesService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // --------------------------------------------------------------------------
  //  findMany — where construction + meta
  // --------------------------------------------------------------------------
  describe('findMany', () => {
    it('builds a where from isActive and a name/department search OR', async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      prisma.employee.count.mockResolvedValue(0);

      await service.findMany({
        page: 1,
        limit: 20,
        isActive: true,
        search: 'ahmed',
      });

      const where = firstArg(prisma.employee.findMany).where as Record<
        string,
        any
      >;
      expect(where.isActive).toBe(true);
      expect(where.OR).toEqual([
        { name: { contains: 'ahmed', mode: 'insensitive' } },
        { department: { contains: 'ahmed', mode: 'insensitive' } },
      ]);
    });

    it('omits isActive from the where when not supplied (includes both)', async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      prisma.employee.count.mockResolvedValue(0);

      await service.findMany({ page: 1, limit: 20 });

      const where = firstArg(prisma.employee.findMany).where as Record<
        string,
        any
      >;
      expect(where).not.toHaveProperty('isActive');
      expect(where).not.toHaveProperty('OR');
    });

    it('keeps isActive:false in the where (a distinct filter from absent)', async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      prisma.employee.count.mockResolvedValue(0);

      await service.findMany({ page: 1, limit: 20, isActive: false });

      const where = firstArg(prisma.employee.findMany).where as Record<
        string,
        any
      >;
      expect(where.isActive).toBe(false);
    });

    it('paginates with skip/take and reports meta', async () => {
      prisma.employee.findMany.mockResolvedValue([]);
      prisma.employee.count.mockResolvedValue(45);

      const { meta } = await service.findMany({ page: 3, limit: 20 });

      const arg = firstArg(prisma.employee.findMany);
      expect(arg.skip).toBe(40);
      expect(arg.take).toBe(20);
      expect(meta).toMatchObject({
        page: 3,
        limit: 20,
        total: 45,
        totalPages: 3,
        hasNextPage: false,
        hasPreviousPage: true,
      });
    });
  });

  // --------------------------------------------------------------------------
  //  update — 404 translation
  // --------------------------------------------------------------------------
  describe('update', () => {
    it('translates Prisma P2025 into a 404', async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        { code: 'P2025', clientVersion: 'test' },
      );
      prisma.employee.update.mockRejectedValue(p2025);

      await expect(
        service.update('missing-id', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  //  setActive — flips the flag, re-reads through the allowlist
  // --------------------------------------------------------------------------
  describe('setActive', () => {
    it('writes the new isActive flag then re-reads the employee', async () => {
      prisma.employee.update.mockResolvedValue({ id: 'e1' });
      prisma.employee.findUnique.mockResolvedValue({
        id: 'e1',
        isActive: false,
      });

      const result = await service.setActive('e1', false);

      expect(firstArg(prisma.employee.update).data).toEqual({
        isActive: false,
      });
      // The response comes from a fresh allowlisted read, not the update return.
      const readArg = firstArg(prisma.employee.findUnique);
      expect(readArg.where).toEqual({ id: 'e1' });
      expect(readArg.select).toBeDefined();
      expect(result).toMatchObject({ id: 'e1', isActive: false });
    });

    it('translates a P2025 on a missing id into a 404', async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError(
        'Record not found',
        { code: 'P2025', clientVersion: 'test' },
      );
      prisma.employee.update.mockRejectedValue(p2025);

      await expect(
        service.setActive('missing-id', false),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not check the cap when deactivating — that frees a slot', async () => {
      prisma.employee.count.mockResolvedValue(MAX_ACTIVE_EMPLOYEES);
      prisma.employee.update.mockResolvedValue({ id: 'e1' });
      prisma.employee.findUnique.mockResolvedValue({
        id: 'e1',
        isActive: false,
      });

      await expect(service.setActive('e1', false)).resolves.toBeDefined();
      expect(prisma.employee.count).not.toHaveBeenCalled();
    });

    it('refuses to activate an 11th employee — otherwise the cap is bypassable', async () => {
      prisma.employee.findUnique.mockResolvedValue({ isActive: false });
      prisma.employee.count.mockResolvedValue(MAX_ACTIVE_EMPLOYEES);

      await expect(service.setActive('e11', true)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });

    it('allows re-activating someone already active — they hold their own slot', async () => {
      prisma.employee.findUnique.mockResolvedValue({ isActive: true });
      prisma.employee.count.mockResolvedValue(MAX_ACTIVE_EMPLOYEES);
      prisma.employee.update.mockResolvedValue({ id: 'e1' });

      await expect(service.setActive('e1', true)).resolves.toBeDefined();
      expect(prisma.employee.count).not.toHaveBeenCalled();
    });

    it('404s when activating an id that does not exist', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.setActive('missing', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // --------------------------------------------------------------------------
  //  create — the Top 10 cap
  // --------------------------------------------------------------------------
  describe('create', () => {
    it('creates when there is a free slot', async () => {
      prisma.employee.count.mockResolvedValue(MAX_ACTIVE_EMPLOYEES - 1);
      prisma.employee.create.mockResolvedValue({ id: 'e10' });

      await expect(service.create({ name: 'Ayesha' })).resolves.toMatchObject({
        id: 'e10',
      });
    });

    it('refuses the 11th active employee with a 409 naming the limit', async () => {
      prisma.employee.count.mockResolvedValue(MAX_ACTIVE_EMPLOYEES);

      await expect(service.create({ name: 'Eleventh' })).rejects.toThrow(
        new RegExp(String(MAX_ACTIVE_EMPLOYEES)),
      );
      expect(prisma.employee.create).not.toHaveBeenCalled();
    });

    it('runs the count and the insert in one serializable transaction', async () => {
      prisma.employee.count.mockResolvedValue(0);
      prisma.employee.create.mockResolvedValue({ id: 'e1' });

      await service.create({ name: 'Ahmed' });

      // Without Serializable, two admins could each read "9 active" and both
      // insert, leaving 11 — a cap expressed as a count has no other defence.
      const options = callArg(prisma.$transaction, 0, 1);
      expect(options.isolationLevel).toBe(
        Prisma.TransactionIsolationLevel.Serializable,
      );
    });
  });

  // --------------------------------------------------------------------------
  //  findByIdOrThrow — 404 rather than a null body
  // --------------------------------------------------------------------------
  describe('findByIdOrThrow', () => {
    it('throws 404 for an unknown id instead of returning null', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.findByIdOrThrow('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // --------------------------------------------------------------------------
  //  remove — history wins over tidiness
  // --------------------------------------------------------------------------
  describe('remove', () => {
    it('deletes an employee that has never been used', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.task.count.mockResolvedValue(0);
      prisma.employee.delete.mockResolvedValue({ id: 'e1' });

      const result = await service.remove('e1');

      expect(result.message).toContain('deleted');
    });

    it('refuses with 409 when tasks reference the employee, and says how many', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.task.count.mockResolvedValue(7);

      await expect(service.remove('e1')).rejects.toThrow(/7 linked task/);
      expect(prisma.employee.delete).not.toHaveBeenCalled();
    });

    it('maps a P2003 from the FK into the same 409 — closing the count/delete race', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'e1' });
      prisma.task.count.mockResolvedValue(0);
      prisma.employee.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('FK violation', {
          code: 'P2003',
          clientVersion: 'test',
        }),
      );

      await expect(service.remove('e1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404s for an unknown id before counting anything', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.task.count).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  //  hoursSaved — the Top 10 tab
  // --------------------------------------------------------------------------
  describe('hoursSaved', () => {
    it('aggregates only COMPLETED tasks for real employees, ranked by time', async () => {
      prisma.task.groupBy.mockResolvedValue([]);
      prisma.employee.findMany.mockResolvedValue([]);

      await service.hoursSaved();

      const arg = firstArg(prisma.task.groupBy);
      expect(arg.by).toEqual(['employeeId']);
      expect(arg.where).toEqual({
        status: TaskStatus.COMPLETED,
        employeeId: { not: null },
      });
      expect(arg.orderBy).toEqual({ _sum: { durationSeconds: 'desc' } });
      // No `take`: the cap on ACTIVE employees keeps the list small, and
      // truncating would hide deactivated employees whose historical hours are
      // exactly what a year-end summary asks about.
      expect(arg.take).toBeUndefined();
    });

    it('windows on endedAt when a date range is given', async () => {
      prisma.task.groupBy.mockResolvedValue([]);
      prisma.employee.findMany.mockResolvedValue([]);

      await service.hoursSaved({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
      });

      // endedAt, not createdAt — "hours saved in August" means hours that
      // finished in August.
      const where = firstArg(prisma.task.groupBy).where as Record<string, any>;
      expect(where.endedAt).toEqual({
        gte: new Date('2026-08-01T00:00:00.000Z'),
        lte: new Date('2026-08-31T23:59:59.999Z'),
      });
    });

    it('attaches names in one findMany and converts seconds to hours (2dp)', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          employeeId: 'e1',
          _count: { _all: 3 },
          _sum: { durationSeconds: 9000, distanceMeters: 4200 }, // 2.5h
        },
        {
          employeeId: 'e2',
          _count: { _all: 1 },
          _sum: { durationSeconds: 5400, distanceMeters: 1500 }, // 1.5h
        },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        {
          id: 'e1',
          name: 'Ahmed Raza',
          department: 'Maintenance Dept',
          isActive: true,
        },
        {
          id: 'e2',
          name: 'Sara Khan',
          department: 'Finance Dept',
          isActive: true,
        },
      ]);

      const { rows } = await service.hoursSaved();

      // A single lookup keyed on the ids the groupBy returned — not N queries.
      expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);
      expect(firstArg(prisma.employee.findMany).where).toEqual({
        id: { in: ['e1', 'e2'] },
      });

      expect(rows).toEqual([
        {
          employeeId: 'e1',
          name: 'Ahmed Raza',
          department: 'Maintenance Dept',
          isActive: true,
          completedTasks: 3,
          totalDurationSeconds: 9000,
          totalDistanceMeters: 4200,
          hoursSaved: 2.5,
        },
        {
          employeeId: 'e2',
          name: 'Sara Khan',
          department: 'Finance Dept',
          isActive: true,
          completedTasks: 1,
          totalDurationSeconds: 5400,
          totalDistanceMeters: 1500,
          hoursSaved: 1.5,
        },
      ]);
    });

    it('totals the collective hours saved from the same rows the table shows', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          employeeId: 'e1',
          _count: { _all: 3 },
          _sum: { durationSeconds: 9000, distanceMeters: 4200 },
        },
        {
          employeeId: 'e2',
          _count: { _all: 1 },
          _sum: { durationSeconds: 5400, distanceMeters: 1500 },
        },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        { id: 'e1', name: 'A', department: null, isActive: true },
        { id: 'e2', name: 'B', department: null, isActive: true },
      ]);

      const { totals } = await service.hoursSaved();

      // Summed from the rows, never re-queried — a footer that disagrees with
      // its own column destroys trust in the whole report.
      expect(totals).toEqual({
        employees: 2,
        completedTasks: 4,
        totalDurationSeconds: 14_400,
        totalDistanceMeters: 5700,
        totalHoursSaved: 4,
      });
    });

    it('rounds fractional hours to two places', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          employeeId: 'e1',
          _count: { _all: 1 },
          _sum: { durationSeconds: 3700, distanceMeters: 0 },
        },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        { id: 'e1', name: 'Ahmed Raza', department: null, isActive: true },
      ]);

      const { rows } = await service.hoursSaved();

      // 3700 / 3600 = 1.0277… → 1.03
      expect(rows[0].hoursSaved).toBe(1.03);
    });

    it('defaults a null duration sum to 0 hours', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          employeeId: 'e1',
          _count: { _all: 0 },
          _sum: { durationSeconds: null, distanceMeters: null },
        },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        { id: 'e1', name: 'Ahmed Raza', department: null, isActive: true },
      ]);

      const { rows } = await service.hoursSaved();

      expect(rows[0].totalDurationSeconds).toBe(0);
      expect(rows[0].hoursSaved).toBe(0);
    });

    it('keeps a deactivated employee on the report, flagged as inactive', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          employeeId: 'e1',
          _count: { _all: 2 },
          _sum: { durationSeconds: 3600, distanceMeters: 100 },
        },
      ]);
      prisma.employee.findMany.mockResolvedValue([
        { id: 'e1', name: 'Retired Rita', department: null, isActive: false },
      ]);

      const { rows } = await service.hoursSaved();

      expect(rows[0]).toMatchObject({ isActive: false, hoursSaved: 1 });
    });

    it('labels an employee that has since vanished rather than dropping the row', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          employeeId: 'gone',
          _count: { _all: 2 },
          _sum: { durationSeconds: 3600, distanceMeters: 0 },
        },
      ]);
      // The join returns nothing for the id — e.g. a hard-deleted employee.
      prisma.employee.findMany.mockResolvedValue([]);

      const { rows } = await service.hoursSaved();

      expect(rows[0]).toMatchObject({
        employeeId: 'gone',
        name: '(unknown)',
        department: null,
        hoursSaved: 1,
      });
    });
  });
});
