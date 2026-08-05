import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { callArg, whereArg } from '../common/testing/mock-args';
import { TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementRateService } from './reimbursement-rate.service';

/**
 * The rate history is the one piece of genuinely subtle arithmetic in the app.
 * A rate applies to `[effectiveFrom, <the next rate's effectiveFrom>)`, so a
 * month that spans a rate change must be priced in two pieces and added up — and
 * getting the boundary wrong by one instant silently changes what somebody is
 * paid.
 *
 * These tests therefore pin: the folding of rows into half-open periods, the
 * clipping of those periods against a requested window, the inclusive-`to`
 * convention the API promises, and the refusal to rewrite a rate that has
 * already priced completed work.
 *
 * Prisma is fully mocked; `task.groupBy` is driven per call so each rate period
 * can return its own distances.
 */
describe('ReimbursementRateService', () => {
  let service: ReimbursementRateService;
  let prisma: {
    reimbursementRate: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
    };
    task: { groupBy: jest.Mock };
  };

  const EPOCH = new Date(0);
  const AUG = new Date('2026-08-01T00:00:00.000Z');

  beforeEach(async () => {
    prisma = {
      reimbursementRate: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
      },
      task: { groupBy: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReimbursementRateService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(ReimbursementRateService);
  });

  // --------------------------------------------------------------------------
  //  periods — folding rows into half-open windows
  // --------------------------------------------------------------------------
  describe('periods', () => {
    it('closes each period at the next rate and leaves the newest open-ended', async () => {
      prisma.reimbursementRate.findMany.mockResolvedValue([
        { ratePerKm: 25, effectiveFrom: EPOCH },
        { ratePerKm: 40, effectiveFrom: AUG },
      ]);

      const periods = await service.periods();

      expect(periods).toEqual([
        { from: EPOCH, to: AUG, ratePerKm: 25 },
        { from: AUG, to: null, ratePerKm: 40 },
      ]);
    });

    it('returns nothing — rather than inventing a rate — when none is configured', async () => {
      prisma.reimbursementRate.findMany.mockResolvedValue([]);

      // A report that shows nothing sends the admin to fix it. One that quietly
      // substitutes a default looks correct and is not.
      await expect(service.periods()).resolves.toEqual([]);
    });

    it('converts the Decimal rate column into a plain number', async () => {
      prisma.reimbursementRate.findMany.mockResolvedValue([
        { ratePerKm: { toNumber: () => 37.5 }, effectiveFrom: EPOCH },
      ]);

      const [period] = await service.periods();

      expect(period.ratePerKm).toBe(37.5);
    });
  });

  // --------------------------------------------------------------------------
  //  calculate — the money
  // --------------------------------------------------------------------------
  describe('calculate', () => {
    beforeEach(() => {
      prisma.reimbursementRate.findMany.mockResolvedValue([
        { ratePerKm: 25, effectiveFrom: EPOCH },
        { ratePerKm: 40, effectiveFrom: AUG },
      ]);
    });

    it('prices each period at its own rate and sums them per office boy', async () => {
      prisma.task.groupBy
        // Pre-August at 25/km: 6 km → 150
        .mockResolvedValueOnce([
          {
            officeBoyId: 'ob1',
            _count: { _all: 2 },
            _sum: { distanceMeters: 6000 },
          },
        ])
        // August onwards at 40/km: 4 km → 160
        .mockResolvedValueOnce([
          {
            officeBoyId: 'ob1',
            _count: { _all: 3 },
            _sum: { distanceMeters: 4000 },
          },
        ]);

      const { totals } = await service.calculate({});
      const ob1 = totals.get('ob1')!;

      expect(ob1.amount).toBe(310);
      expect(ob1.completedTasks).toBe(5);
      expect(ob1.totalDistanceMeters).toBe(10_000);
      // The breakdown is what makes 310 explainable rather than magic.
      expect(ob1.breakdown).toEqual([
        expect.objectContaining({ ratePerKm: 25, amount: 150 }),
        expect.objectContaining({ ratePerKm: 40, amount: 160 }),
      ]);
    });

    it('queries each period with a half-open endedAt window', async () => {
      await service.calculate({});

      const first = whereArg(prisma.task.groupBy, 0);
      const second = whereArg(prisma.task.groupBy, 1);

      expect(first.status).toBe(TaskStatus.COMPLETED);
      // `lt` not `lte`: a task ending exactly at the changeover instant belongs
      // to the NEW rate, and must be counted once, not twice.
      expect(first.endedAt).toEqual({ gte: EPOCH, lt: AUG });
      expect(second.endedAt).toEqual({ gte: AUG });
      expect(second.endedAt).not.toHaveProperty('lt');
    });

    it('treats the API `to` as inclusive by nudging it one millisecond', async () => {
      await service.calculate({ to: '2026-08-31T23:59:59.999Z' });

      const endedAt = whereArg(prisma.task.groupBy, -1).endedAt as Record<
        string,
        unknown
      >;
      // A task ending at exactly 23:59:59.999 must be inside the month.
      expect(endedAt.lt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it('skips a rate period that lies entirely outside the requested window', async () => {
      // Ask only for September — the pre-August period cannot contribute.
      await service.calculate({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-09-30T23:59:59.999Z',
      });

      expect(prisma.task.groupBy).toHaveBeenCalledTimes(1);
      const endedAt = whereArg(prisma.task.groupBy, 0).endedAt as Record<
        string,
        unknown
      >;
      expect(endedAt.gte).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    });

    it('scopes to one office boy when asked', async () => {
      await service.calculate({ officeBoyId: 'ob1' });

      expect(whereArg(prisma.task.groupBy, 0).officeBoyId).toBe('ob1');
    });

    it('treats a null distance sum as zero distance, not a crash', async () => {
      prisma.task.groupBy.mockResolvedValue([
        {
          officeBoyId: 'ob1',
          _count: { _all: 1 },
          _sum: { distanceMeters: null },
        },
      ]);

      const { totals } = await service.calculate({});

      expect(totals.get('ob1')!.amount).toBe(0);
    });

    it('rounds each period slice to 2dp so the sum matches what is paid out', async () => {
      prisma.task.groupBy
        .mockResolvedValueOnce([
          {
            officeBoyId: 'ob1',
            _count: { _all: 1 },
            _sum: { distanceMeters: 3333 }, // 3.333 km × 25 = 83.325 → 83.33
          },
        ])
        .mockResolvedValueOnce([]);

      const { totals } = await service.calculate({});

      expect(totals.get('ob1')!.amount).toBe(83.33);
    });
  });

  // --------------------------------------------------------------------------
  //  forOfficeBoy — the office boy's own KPI figure
  // --------------------------------------------------------------------------
  describe('forOfficeBoy', () => {
    it('returns a zero total for someone with no completed work', async () => {
      prisma.reimbursementRate.findMany.mockResolvedValue([
        { ratePerKm: 25, effectiveFrom: EPOCH },
      ]);
      prisma.task.groupBy.mockResolvedValue([]);

      await expect(service.forOfficeBoy('ob-new')).resolves.toEqual({
        officeBoyId: 'ob-new',
        completedTasks: 0,
        totalDistanceMeters: 0,
        amount: 0,
        breakdown: [],
      });
    });
  });

  // --------------------------------------------------------------------------
  //  Writes — append-only history
  // --------------------------------------------------------------------------
  describe('create', () => {
    it('defaults effectiveFrom to now and records the author', async () => {
      prisma.reimbursementRate.create.mockResolvedValue({
        id: 'r1',
        ratePerKm: 40,
        effectiveFrom: new Date(),
        note: null,
        createdAt: new Date(),
        createdBy: null,
      });

      await service.create({ ratePerKm: 40 }, 'admin-1');

      const data = callArg(prisma.reimbursementRate.create, 0).data as Record<
        string,
        unknown
      >;
      expect(data.createdById).toBe('admin-1');
      expect(data.effectiveFrom).toBeInstanceOf(Date);
    });
  });

  describe('remove', () => {
    it('withdraws a rate that has not taken effect yet', async () => {
      prisma.reimbursementRate.findUnique.mockResolvedValue({
        id: 'r1',
        effectiveFrom: new Date(Date.now() + 86_400_000),
      });

      const result = await service.remove('r1');

      expect(result.message).toContain('withdrawn');
      expect(prisma.reimbursementRate.delete).toHaveBeenCalled();
    });

    it('refuses to delete a rate already in force — that would reprice history', async () => {
      prisma.reimbursementRate.findUnique.mockResolvedValue({
        id: 'r1',
        effectiveFrom: new Date(Date.now() - 86_400_000),
      });

      await expect(service.remove('r1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.reimbursementRate.delete).not.toHaveBeenCalled();
    });

    it('404s for an unknown id', async () => {
      prisma.reimbursementRate.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
