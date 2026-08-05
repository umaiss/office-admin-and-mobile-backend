import { Test, TestingModule } from '@nestjs/testing';

import { firstArg } from '../common/testing/mock-args';
import { AppConfigService } from '../config/app-config.service';
import { TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementRateService } from '../reimbursement/reimbursement-rate.service';
import { TasksService } from '../tasks/tasks.service';
import { AdminService } from './admin.service';

/**
 * AdminService is the read-only, cross-office-boy counterpart to TasksService.
 * The database enforces none of what matters here, so these tests pin the parts
 * that live in code: how the query DTO becomes a Prisma `where` (the search OR,
 * the `completedToday` override), how per-office-boy statistics are assembled
 * from three aggregates without an N+1, and how the petty cash feed derives its
 * net amounts.
 *
 * The reimbursement ARITHMETIC is not retested here — it lives in
 * `ReimbursementRateService`, which has its own spec covering the rate-period
 * folding. What is tested here is that this service attaches display identity to
 * whatever that calculation returns and sorts it for the report.
 *
 * Prisma is fully mocked. `$transaction` resolves the array of promises the
 * service hands it, exactly as the real client does for a batched read.
 */
describe('AdminService', () => {
  let service: AdminService;
  let prisma: {
    task: {
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
      aggregate: jest.Mock;
    };
    user: {
      count: jest.Mock;
      findMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let rates: {
    calculate: jest.Mock;
    current: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      task: {
        findMany: jest.fn(),
        count: jest.fn(),
        groupBy: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({
          _sum: { amountReceived: null, amountReturned: null },
        }),
      },
      user: {
        count: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops as Promise<unknown>[]) : undefined,
      ),
    };

    rates = {
      calculate: jest
        .fn()
        .mockResolvedValue({ periods: [], totals: new Map() }),
      current: jest.fn().mockResolvedValue({ ratePerKm: 25 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        // AdminService only delegates findOne to it; a bare stub is enough.
        { provide: TasksService, useValue: { findOne: jest.fn() } },
        { provide: ReimbursementRateService, useValue: rates },
        { provide: AppConfigService, useValue: { reportTzOffsetMinutes: 0 } },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // --------------------------------------------------------------------------
  //  listAll — where construction
  // --------------------------------------------------------------------------
  describe('listAll where', () => {
    it('expands search into a case-insensitive OR across every free-text field', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      prisma.task.count.mockResolvedValue(0);

      await service.listAll({ page: 1, limit: 20, search: 'bank' });

      const where = firstArg(prisma.task.findMany).where as Record<string, any>;
      expect(where.OR).toEqual([
        { title: { contains: 'bank', mode: 'insensitive' } },
        { description: { contains: 'bank', mode: 'insensitive' } },
        { destination: { contains: 'bank', mode: 'insensitive' } },
        { vendorDetails: { contains: 'bank', mode: 'insensitive' } },
      ]);
    });

    it('the completedToday override pins status to COMPLETED and a date window, ignoring a supplied status', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      prisma.task.count.mockResolvedValue(0);

      await service.listAll({
        page: 1,
        limit: 20,
        completedToday: true,
        status: TaskStatus.PENDING, // must be overridden, not merged
      });

      const where = firstArg(prisma.task.findMany).where as Record<string, any>;
      expect(where.status).toBe(TaskStatus.COMPLETED);
      expect(where.endedAt).toHaveProperty('gte');
      expect(where.endedAt).toHaveProperty('lt');
    });

    it('paginates with skip/take derived from page and limit', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      prisma.task.count.mockResolvedValue(45);

      const { meta } = await service.listAll({ page: 3, limit: 20 });

      const arg = firstArg(prisma.task.findMany);
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
  //  stats — shape + defaults
  // --------------------------------------------------------------------------
  describe('stats', () => {
    it('fills absent statuses with 0 and defaults null sums to 0', async () => {
      prisma.task.groupBy.mockResolvedValue([
        { status: TaskStatus.COMPLETED, _count: { _all: 4 } },
      ]);
      prisma.task.count
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(4) // completedToday
        .mockResolvedValueOnce(2) // pendingSubmissions
        .mockResolvedValueOnce(3); // tasksWithReceipt
      prisma.task.aggregate.mockResolvedValue({
        _sum: {
          distanceMeters: null,
          durationSeconds: null,
          amountReceived: null,
          amountReturned: null,
        },
      });
      prisma.user.count.mockResolvedValue(7);

      const result = await service.stats();

      expect(result).toMatchObject({
        tasks: {
          total: 10,
          [TaskStatus.PENDING]: 0,
          [TaskStatus.IN_PROGRESS]: 0,
          [TaskStatus.COMPLETED]: 4,
          [TaskStatus.CANCELLED]: 0,
        },
        completedToday: 4,
        pendingSubmissions: 2,
        tasksWithReceipt: 3,
        totalDistanceMeters: 0,
        totalDurationSeconds: 0,
        totalAmountReceived: 0,
        totalAmountReturned: 0,
        netAmount: 0,
        activeOfficeBoys: 7,
        currentRatePerKm: 25,
      });
    });

    it('converts Decimal settlement sums to numbers and derives the net', async () => {
      prisma.task.groupBy.mockResolvedValue([]);
      prisma.task.count.mockResolvedValue(0);
      prisma.task.aggregate.mockResolvedValue({
        _sum: {
          distanceMeters: 0,
          durationSeconds: 0,
          // Prisma hands these back as Decimal instances, which stringify.
          amountReceived: { toNumber: () => 1500 },
          amountReturned: { toNumber: () => 430.25 },
        },
      });
      prisma.user.count.mockResolvedValue(0);

      const result = await service.stats();

      expect(result.totalAmountReceived).toBe(1500);
      expect(result.totalAmountReturned).toBe(430.25);
      expect(result.netAmount).toBe(1069.75);
    });

    it('reports a null rate rather than inventing one when none is configured', async () => {
      prisma.task.groupBy.mockResolvedValue([]);
      prisma.task.count.mockResolvedValue(0);
      prisma.user.count.mockResolvedValue(0);
      rates.current.mockResolvedValue(null);

      await expect(service.stats()).resolves.toMatchObject({
        currentRatePerKm: null,
      });
    });
  });

  // --------------------------------------------------------------------------
  //  reimbursements — identity and ordering over the shared calculation
  // --------------------------------------------------------------------------
  describe('reimbursements', () => {
    it('attaches names to the calculated totals and sorts highest amount first', async () => {
      rates.calculate.mockResolvedValue({
        periods: [{ from: new Date(0), to: null, ratePerKm: 25 }],
        totals: new Map([
          [
            'ob-small',
            {
              officeBoyId: 'ob-small',
              completedTasks: 1,
              totalDistanceMeters: 3000,
              amount: 75,
              breakdown: [],
            },
          ],
          [
            'ob-big',
            {
              officeBoyId: 'ob-big',
              completedTasks: 2,
              totalDistanceMeters: 12345,
              amount: 308.63,
              breakdown: [],
            },
          ],
        ]),
      });
      prisma.user.findMany.mockResolvedValue([
        { id: 'ob-big', name: 'Big Runner', email: 'big@obtrack.local' },
        { id: 'ob-small', name: 'Small Runner', email: 'small@obtrack.local' },
      ]);

      const result = await service.reimbursements({});

      // Sorted by amount desc — the big runner leads.
      expect(result.rows.map((r) => r.officeBoyId)).toEqual([
        'ob-big',
        'ob-small',
      ]);
      expect(result.rows[0]).toMatchObject({
        name: 'Big Runner',
        completedTasks: 2,
        totalDistanceMeters: 12345,
        amount: 308.63,
      });
      expect(result.totalAmount).toBe(383.63);
      expect(result.currentRatePerKm).toBe(25);
      expect(result.rates).toHaveLength(1);
    });

    it('looks identity up in one query for all office boys, not one each', async () => {
      rates.calculate.mockResolvedValue({
        periods: [],
        totals: new Map([
          [
            'a',
            {
              officeBoyId: 'a',
              completedTasks: 1,
              totalDistanceMeters: 0,
              amount: 0,
              breakdown: [],
            },
          ],
          [
            'b',
            {
              officeBoyId: 'b',
              completedTasks: 1,
              totalDistanceMeters: 0,
              amount: 0,
              breakdown: [],
            },
          ],
        ]),
      });

      await service.reimbursements({});

      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(firstArg(prisma.user.findMany).where).toEqual({
        id: { in: ['a', 'b'] },
      });
    });

    it('labels a vanished user gracefully rather than dropping the payable row', async () => {
      rates.calculate.mockResolvedValue({
        periods: [],
        totals: new Map([
          [
            'ghost',
            {
              officeBoyId: 'ghost',
              completedTasks: 1,
              totalDistanceMeters: 1000,
              amount: 25,
              breakdown: [],
            },
          ],
        ]),
      });
      prisma.user.findMany.mockResolvedValue([]); // user row gone

      const result = await service.reimbursements({});

      expect(result.rows[0]).toMatchObject({ name: '(unknown)', email: '' });
    });

    it('rejects a reversed date window rather than silently returning nothing', async () => {
      await expect(
        service.reimbursements({
          from: '2026-08-31T00:00:00.000Z',
          to: '2026-08-01T00:00:00.000Z',
        }),
      ).rejects.toThrow(/from/);
    });
  });

  // --------------------------------------------------------------------------
  //  officeBoyStats — assembled from aggregates, never N+1
  // --------------------------------------------------------------------------
  describe('officeBoyStats', () => {
    beforeEach(() => {
      prisma.task.groupBy
        .mockResolvedValueOnce([
          {
            officeBoyId: 'ob1',
            status: TaskStatus.COMPLETED,
            _count: { _all: 3 },
          },
          {
            officeBoyId: 'ob1',
            status: TaskStatus.PENDING,
            _count: { _all: 1 },
          },
        ])
        .mockResolvedValueOnce([
          {
            officeBoyId: 'ob1',
            _count: { _all: 3 },
            _sum: {
              distanceMeters: 6000,
              durationSeconds: 5400,
              amountReceived: { toNumber: () => 900 },
              amountReturned: { toNumber: () => 250 },
            },
            _avg: { durationSeconds: 1800 },
            _max: { endedAt: new Date('2026-08-03T10:00:00.000Z') },
          },
        ]);
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'ob1',
          name: 'Bilal Ahmed',
          email: 'bilal@obtrack.local',
          isActive: true,
          lastLoginAt: null,
        },
        {
          id: 'ob2',
          name: 'Idle Ivan',
          email: 'ivan@obtrack.local',
          isActive: true,
          lastLoginAt: null,
        },
      ]);
      rates.calculate.mockResolvedValue({
        periods: [],
        totals: new Map([
          [
            'ob1',
            {
              officeBoyId: 'ob1',
              completedTasks: 3,
              totalDistanceMeters: 6000,
              amount: 150,
              breakdown: [],
            },
          ],
        ]),
      });
    });

    it('builds a full row per office boy from the aggregates', async () => {
      const { rows } = await service.officeBoyStats({});

      const bilal = rows.find((r) => r.officeBoyId === 'ob1');
      expect(bilal).toMatchObject({
        name: 'Bilal Ahmed',
        tasks: {
          total: 4,
          COMPLETED: 3,
          PENDING: 1,
          IN_PROGRESS: 0,
          CANCELLED: 0,
        },
        completedTasks: 3,
        totalDistanceMeters: 6000,
        totalDurationSeconds: 5400,
        averageDurationSeconds: 1800,
        totalAmountReceived: 900,
        totalAmountReturned: 250,
        netAmount: 650,
        reimbursementAmount: 150,
      });
    });

    it('keeps an office boy with no tasks as a zero row rather than omitting them', async () => {
      const { rows } = await service.officeBoyStats({});

      // Absence would read as a missing record; a zero row says "did nothing".
      const ivan = rows.find((r) => r.officeBoyId === 'ob2');
      expect(ivan).toMatchObject({
        tasks: { total: 0 },
        completedTasks: 0,
        reimbursementAmount: 0,
        lastTaskAt: null,
      });
    });

    it('sums the per-person rows into the footer totals', async () => {
      const { totals } = await service.officeBoyStats({});

      expect(totals).toMatchObject({
        officeBoys: 2,
        completedTasks: 3,
        totalDistanceMeters: 6000,
        totalAmountReceived: 900,
        netAmount: 650,
        reimbursementAmount: 150,
      });
    });
  });

  // --------------------------------------------------------------------------
  //  receipts — the petty cash feed
  // --------------------------------------------------------------------------
  describe('receipts', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: 'task-1',
      title: 'Bank run',
      description: 'Deposit cheque',
      destination: 'HBL',
      endedAt: new Date('2026-08-02T10:00:00.000Z'),
      submittedAt: new Date('2026-08-02T10:05:00.000Z'),
      amountReceived: { toNumber: () => 500 },
      amountReturned: { toNumber: () => 120.5 },
      vendorDetails: 'Al-Fatah Superstore, Gulberg — invoice #A-4471',
      distanceMeters: 2100,
      durationSeconds: 900,
      officeBoy: { id: 'ob1', name: 'Bilal', email: 'b@x.local' },
      employee: null,
      receipt: {
        id: 'r1',
        originalName: 'slip.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        uploadedAt: new Date(),
      },
      ...overrides,
    });

    it('scopes to COMPLETED tasks and derives the net each row cost', async () => {
      prisma.task.findMany.mockResolvedValue([row()]);
      prisma.task.count.mockResolvedValue(1);

      const result = await service.receipts({ page: 1, limit: 20 });

      expect(firstArg(prisma.task.findMany).where).toMatchObject({
        status: TaskStatus.COMPLETED,
      });
      expect(result.items[0]).toMatchObject({
        amountReceived: 500,
        amountReturned: 120.5,
        netAmount: 379.5,
        // The vendor rides along with the amount: an expense line is reconciled
        // against both together, so a feed carrying one without the other would
        // send the admin back to the task detail for every row.
        vendorDetails: 'Al-Fatah Superstore, Gulberg — invoice #A-4471',
        receiptUrl: '/api/v1/tasks/task-1/receipt',
      });
    });

    it('surfaces a null vendor rather than omitting the key', async () => {
      prisma.task.findMany.mockResolvedValue([row({ vendorDetails: null })]);
      prisma.task.count.mockResolvedValue(1);

      const result = await service.receipts({ page: 1, limit: 20 });

      expect(result.items[0]).toHaveProperty('vendorDetails', null);
    });

    it('returns a null receiptUrl when nothing is attached', async () => {
      prisma.task.findMany.mockResolvedValue([row({ receipt: null })]);
      prisma.task.count.mockResolvedValue(1);

      const result = await service.receipts({ page: 1, limit: 20 });

      expect(result.items[0].receiptUrl).toBeNull();
    });

    it('translates hasReceipt/submitted into relation and null filters', async () => {
      prisma.task.findMany.mockResolvedValue([]);
      prisma.task.count.mockResolvedValue(0);

      await service.receipts({
        page: 1,
        limit: 20,
        hasReceipt: false,
        submitted: false,
      });

      const where = firstArg(prisma.task.findMany).where as Record<string, any>;
      expect(where.receipt).toEqual({ is: null });
      expect(where.submittedAt).toBeNull();
    });

    it('totals the whole filtered set, not just the current page', async () => {
      prisma.task.findMany.mockResolvedValue([row()]);
      prisma.task.count.mockResolvedValue(500);
      prisma.task.aggregate.mockResolvedValue({
        _sum: {
          amountReceived: { toNumber: () => 90_000 },
          amountReturned: { toNumber: () => 12_000 },
        },
      });

      const result = await service.receipts({ page: 1, limit: 20 });

      // An admin reconciling a month needs the month's figure, not page 1 of it.
      expect(result.totals).toEqual({
        totalAmountReceived: 90_000,
        totalAmountReturned: 12_000,
        netAmount: 78_000,
      });
      expect(result.meta.total).toBe(500);
    });
  });
});
