import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { callArg, firstArg } from '../common/testing/mock-args';
import { AppConfigService } from '../config/app-config.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { PettyCashService, TaskEntryParams } from './petty-cash.service';
import { ReceiptDuplicateService } from './receipt-duplicate.service';
import { ReceiptExtractionService } from './receipt-extraction.service';

/**
 * The ledger's arithmetic and its money-moving guards.
 *
 * Three things here cannot be enforced by the schema and are the reason this
 * file exists: a running balance must be the ledger's own arithmetic rather
 * than a filtered slice's; opening a month must not close the previous one
 * unless the new one is actually created; and a task expense must never be
 * booked twice or into a closed month. Prisma is fully mocked — `$transaction`
 * hands the callback the same mock object, so writes inside a transaction land
 * on the same spies as writes outside.
 */
describe('PettyCashService', () => {
  let service: PettyCashService;
  let prisma: {
    pettyCashMonthlyLedger: {
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    pettyCashLedgerEntry: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      aggregate: jest.Mock;
      groupBy: jest.Mock;
    };
    pettyCashBalanceAdjustment: {
      create: jest.Mock;
      findMany: jest.Mock;
      groupBy: jest.Mock;
    };
    pendingReceiptScan: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let storage: {
    save: jest.Mock;
    createReadStream: jest.Mock;
    delete: jest.Mock;
    exists: jest.Mock;
  };
  let extractor: { enabled: boolean; extract: jest.Mock };
  let duplicates: { hash: jest.Mock; find: jest.Mock };

  const ADMIN_ID = 'admin-1';
  const LEDGER_ID = 'ledger-2026-08';
  const ENTRY_ID = 'entry-1';
  const TASK_ID = 'task-1';

  const decimal = (n: number) => new Prisma.Decimal(n);

  /** A monthly ledger row as Prisma returns it. */
  const ledgerRow = (overrides: Record<string, unknown> = {}) => ({
    id: LEDGER_ID,
    year: 2026,
    month: 8,
    openingBalance: decimal(5000),
    openingBalanceSource: 'MANUAL',
    totalExpenses: decimal(0),
    remainingBalance: decimal(5000),
    isClosed: false,
    note: null,
    createdAt: new Date('2026-08-01T04:12:55.000Z'),
    ...overrides,
  });

  /** A ledger entry row with every relation `ENTRY_INCLUDE` asks for. */
  const entryRow = (overrides: Record<string, unknown> = {}) => ({
    id: ENTRY_ID,
    monthlyLedgerId: LEDGER_ID,
    source: 'MANUAL',
    amount: decimal(250),
    category: 'FUEL',
    description: 'Diesel',
    supplier: 'Shell',
    entryDate: new Date('2026-08-05T00:00:00.000Z'),
    paymentMethod: 'PETTY_CASH',
    staffId: null,
    taskId: null,
    notes: null,
    createdAt: new Date('2026-08-05T09:00:00.000Z'),
    staff: null,
    createdBy: { id: ADMIN_ID, name: 'Farid' },
    receipt: null,
    task: null,
    ...overrides,
  });

  /** A valid JPEG header, enough for the magic-byte sniff. */
  const jpegBuffer = () =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

  const uploadedFile = (overrides: Record<string, unknown> = {}) =>
    ({
      buffer: jpegBuffer(),
      originalname: 'receipt.jpg',
      mimetype: 'image/jpeg',
      size: 24,
      ...overrides,
    }) as Express.Multer.File;

  beforeEach(async () => {
    prisma = {
      pettyCashMonthlyLedger: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn().mockResolvedValue(ledgerRow()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(ledgerRow()),
        update: jest.fn().mockResolvedValue(ledgerRow()),
      },
      pettyCashLedgerEntry: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue(entryRow()),
        update: jest.fn().mockResolvedValue(entryRow()),
        delete: jest.fn().mockResolvedValue(entryRow()),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      pettyCashBalanceAdjustment: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      pendingReceiptScan: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // Mirror both Prisma shapes: an array of queries (listEntries) and a
      // callback receiving the transaction client (every write path).
      $transaction: jest.fn((ops: unknown) => {
        if (Array.isArray(ops)) {
          return Promise.all(ops as Promise<unknown>[]);
        }
        if (typeof ops === 'function') {
          return (ops as (tx: unknown) => unknown)(prisma);
        }
        return undefined;
      }),
    };

    storage = {
      save: jest.fn().mockResolvedValue({
        key: 'petty-cash-receipts/2026/08/generated.jpg',
        sizeBytes: 24,
        mimeType: 'image/jpeg',
      }),
      createReadStream: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
    };

    // Default: extraction read nothing. Individual tests opt into a confident
    // result, so a test that auto-creates has to say so explicitly.
    extractor = {
      enabled: true,
      extract: jest.fn().mockResolvedValue({ confidence: 0 }),
    };

    // Default: not a duplicate. Tests that care opt in.
    duplicates = {
      hash: jest.fn().mockReturnValue('sha256-of-the-upload'),
      find: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PettyCashService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: ReceiptExtractionService, useValue: extractor },
        { provide: ReceiptDuplicateService, useValue: duplicates },
        {
          provide: AppConfigService,
          useValue: {
            maxReceiptBytes: 5_242_880,
            receiptAutoCreateConfidence: 0.85,
          },
        },
      ],
    }).compile();

    service = module.get<PettyCashService>(PettyCashService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // --------------------------------------------------------------------------
  //  Opening a month
  // --------------------------------------------------------------------------
  describe('openMonth', () => {
    it('uses the supplied amount and leaves the previous month alone', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(null);

      await service.openMonth({ year: 2026, month: 8, amount: 5000 }, ADMIN_ID);

      const created = firstArg(prisma.pettyCashMonthlyLedger.create) as {
        data: { openingBalance: number; openingBalanceSource: string };
      };
      expect(created.data.openingBalance).toBe(5000);
      expect(created.data.openingBalanceSource).toBe('MANUAL');
      // Nothing to carry forward from, so nothing gets closed.
      expect(prisma.pettyCashMonthlyLedger.update).not.toHaveBeenCalled();
    });

    it('carries the previous balance forward and closes that month', async () => {
      prisma.pettyCashMonthlyLedger.findUnique
        // the month being opened — not yet present
        .mockResolvedValueOnce(null)
        // the previous month, with money left over
        .mockResolvedValueOnce(
          ledgerRow({
            id: 'ledger-2026-07',
            month: 7,
            remainingBalance: decimal(1234),
          }),
        );

      await service.openMonth({ year: 2026, month: 8 }, ADMIN_ID);

      const created = firstArg(prisma.pettyCashMonthlyLedger.create) as {
        data: { openingBalance: Prisma.Decimal; openingBalanceSource: string };
      };
      expect(Number(created.data.openingBalance)).toBe(1234);
      expect(created.data.openingBalanceSource).toBe('CARRY_FORWARD');
      expect(firstArg(prisma.pettyCashMonthlyLedger.update)).toEqual({
        where: { id: 'ledger-2026-07' },
        data: { isClosed: true },
      });
    });

    it('rolls the whole open back rather than closing a month it cannot carry forward into', async () => {
      prisma.pettyCashMonthlyLedger.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(ledgerRow({ id: 'ledger-2026-07', month: 7 }));
      prisma.pettyCashMonthlyLedger.create.mockRejectedValue(
        new Error('constraint violation'),
      );

      await expect(
        service.openMonth({ year: 2026, month: 8 }, ADMIN_ID),
      ).rejects.toThrow();

      // The close and the create are one transaction — Prisma rolls the close
      // back for us. What this pins down is that they are in fact issued
      // through the same $transaction callback, which is what makes that true.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(typeof firstArg(prisma.$transaction)).toBe('function');
    });

    it('refuses to reopen a month that is already open', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await expect(
        service.openMonth({ year: 2026, month: 8, amount: 5000 }, ADMIN_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.pettyCashMonthlyLedger.create).not.toHaveBeenCalled();
    });

    it('explains what to do when there is no previous month', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(null);

      await expect(
        service.openMonth({ year: 2026, month: 8 }, ADMIN_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // --------------------------------------------------------------------------
  //  Listing
  // --------------------------------------------------------------------------
  describe('listEntries', () => {
    it('returns the shared { data, meta } envelope', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
      prisma.pettyCashLedgerEntry.findMany.mockResolvedValue([entryRow()]);
      prisma.pettyCashLedgerEntry.count.mockResolvedValue(45);

      const result = await service.listEntries({
        year: 2026,
        month: 8,
        page: 2,
        limit: 20,
      });

      expect(result.meta).toEqual({
        page: 2,
        limit: 20,
        total: 45,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true,
      });
      expect(result.data).toHaveLength(1);
    });

    it('computes the running balance over the ledger, not the caller’s filters', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
      prisma.pettyCashLedgerEntry.findMany.mockResolvedValue([entryRow()]);
      prisma.pettyCashLedgerEntry.count.mockResolvedValue(1);

      await service.listEntries({
        year: 2026,
        month: 8,
        page: 1,
        limit: 20,
        category: 'FUEL',
        search: 'Shell',
      });

      // Call 0 is the page query and SHOULD carry the filters.
      const paged = callArg(prisma.pettyCashLedgerEntry.findMany, 0) as {
        where: Record<string, unknown>;
      };
      expect(paged.where.category).toBe('FUEL');

      // Call 1 computes the balances. A running balance is the ledger's own
      // arithmetic; narrowed to the FUEL rows it would be a plausible-looking
      // number that reconciles against nothing.
      const balances = callArg(prisma.pettyCashLedgerEntry.findMany, 1) as {
        where: Record<string, unknown>;
      };
      expect(balances.where).toEqual({ monthlyLedgerId: LEDGER_ID });
      expect(balances.where.category).toBeUndefined();
      expect(balances.where.OR).toBeUndefined();
    });

    it('renders an empty page rather than a 404 when the month was never opened', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(null);

      const result = await service.listEntries({
        year: 2026,
        month: 8,
        page: 1,
        limit: 20,
      });

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });

    it('points the receipt url at the versioned route the client can actually GET', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
      prisma.pettyCashLedgerEntry.findMany.mockResolvedValue([
        entryRow({
          receipt: { id: 'r-1', mimeType: 'image/jpeg', storageKey: 'k' },
        }),
      ]);
      prisma.pettyCashLedgerEntry.count.mockResolvedValue(1);

      const result = await service.listEntries({
        year: 2026,
        month: 8,
        page: 1,
        limit: 20,
      });

      expect(result.data[0]?.receipt?.url).toBe(
        `/api/v1/petty-cash/entries/${ENTRY_ID}/receipt`,
      );
    });
  });

  // --------------------------------------------------------------------------
  //  Booking a task expense
  // --------------------------------------------------------------------------
  describe('createFromTask', () => {
    const params = {
      taskId: TASK_ID,
      officeBoyId: 'ob-1',
      amountSpent: 250,
      typedNetAmount: 250,
      description: 'Courier run',
      entryDate: new Date('2026-08-05T00:00:00.000Z'),
    };

    it('joins a supplied transaction instead of opening its own', async () => {
      const tx = {
        pettyCashLedgerEntry: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(entryRow()),
          findMany: jest.fn().mockResolvedValue([]),
          aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        },
        pettyCashMonthlyLedger: {
          findUnique: jest.fn().mockResolvedValue(ledgerRow()),
          findUniqueOrThrow: jest.fn().mockResolvedValue(ledgerRow()),
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn().mockResolvedValue(ledgerRow()),
        },
        pettyCashBalanceAdjustment: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      await service.createFromTask(params, tx as never);

      // The whole point: the Task module's submit owns the transaction, so this
      // must not start a second one that could commit independently.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.pettyCashLedgerEntry.create).toHaveBeenCalled();
    });

    it('opens its own transaction when called standalone', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await service.createFromTask(params);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('refuses to settle the same task twice', async () => {
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(entryRow());

      await expect(service.createFromTask(params)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.pettyCashLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('refuses a month that has been closed', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(
        ledgerRow({ isClosed: true }),
      );

      await expect(service.createFromTask(params)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a month that was never opened', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(null);

      await expect(service.createFromTask(params)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // --------------------------------------------------------------------------
  //  Office boy receipts — the receipt drives the entry
  // --------------------------------------------------------------------------
  describe('createFromTask — receipt-driven entries', () => {
    const base = {
      taskId: TASK_ID,
      officeBoyId: 'ob-1',
      description: 'Deliver documents',
      vendorDetails: 'typed vendor',
      entryDate: new Date('2026-08-05T00:00:00.000Z'),
    };

    type Scanned = NonNullable<TaskEntryParams['scanned']>;

    const scanned = (overrides: Partial<Scanned> = {}): Scanned => ({
      amount: 2145.5,
      vendor: 'Shell Petrol Station',
      date: '2026-08-05',
      category: 'FUEL',
      description: 'Diesel, 32 litres',
      confidence: 0.95,
      ...overrides,
    });

    beforeEach(() => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
    });

    const created = () =>
      firstArg(prisma.pettyCashLedgerEntry.create) as {
        data: Record<string, unknown>;
      };

    it("files the receipt's category, vendor and description over the task's", async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 2145.5,
        typedNetAmount: 2145.5,
        scanned: scanned(),
      });

      const data = created().data;
      // "Diesel, 32 litres" reconciles against a fuel bill; "Deliver documents"
      // does not. Same for the vendor the office boy typed by hand.
      expect(data.category).toBe('FUEL');
      expect(data.supplier).toBe('Shell Petrol Station');
      expect(data.description).toBe('Diesel, 32 litres');
      expect(data.needsReview).toBe(false);
      expect(data.reviewNote).toBeNull();
    });

    it('links the entry to the task and the office boy', async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 2145.5,
        typedNetAmount: 2145.5,
        scanned: scanned(),
      });

      const data = created().data;
      expect(data.taskId).toBe(TASK_ID);
      expect(data.staffId).toBe('ob-1');
      expect(data.createdById).toBe('ob-1');
      expect(data.source).toBe('TASK');
    });

    it('flags the entry when the receipt disagrees with what he recorded', async () => {
      // The check worth having: the receipt says 2145.50, the cash he handed
      // back says he spent 2000.
      await service.createFromTask({
        ...base,
        amountSpent: 2145.5,
        typedNetAmount: 2000,
        scanned: scanned(),
      });

      const data = created().data;
      expect(data.needsReview).toBe(true);
      expect(String(data.reviewNote)).toContain('2145.5');
      expect(String(data.reviewNote)).toContain('2000');
      expect(String(data.reviewNote)).toContain('145.5');
      // The entry is still filed — an expense that happened must not become
      // invisible because it needs checking.
      expect(data.amount).toBe(2145.5);
    });

    it('tolerates a rounding-level difference without flagging', async () => {
      // Flagging every task over half a rupee trains people to ignore the queue.
      await service.createFromTask({
        ...base,
        amountSpent: 2145.5,
        typedNetAmount: 2145,
        scanned: scanned(),
      });

      expect(created().data.needsReview).toBe(false);
    });

    it('flags a low-confidence read', async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 2145.5,
        typedNetAmount: 2145.5,
        scanned: scanned({ confidence: 0.4 }),
      });

      const data = created().data;
      expect(data.needsReview).toBe(true);
      expect(String(data.reviewNote)).toContain('0.40');
    });

    it('falls back to his typed amount when no total could be read', async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 400,
        typedNetAmount: 400,
        scanned: scanned({ amount: undefined }),
      });

      const data = created().data;
      expect(data.amount).toBe(400);
      expect(data.needsReview).toBe(true);
      expect(String(data.reviewNote)).toContain('no total could be read');
    });

    it('flags an entry filed with no receipt at all', async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 400,
        typedNetAmount: 400,
      });

      const data = created().data;
      expect(data.needsReview).toBe(true);
      expect(String(data.reviewNote)).toContain('No receipt');
      // Falls back to the old behaviour for category and description.
      expect(data.category).toBe('MISCELLANEOUS');
      expect(data.description).toBe('Deliver documents');
    });

    it('flags when extraction failed outright', async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 400,
        typedNetAmount: 400,
        scanned: scanned({
          amount: undefined,
          failureReason: 'Extraction service unavailable.',
        }),
      });

      const note = String(created().data.reviewNote);
      // Names the system as the cause, not the photo — an admin sent to
      // re-examine a perfectly good receipt is the failure this avoids.
      expect(note).toContain('Extraction service unavailable.');
      expect(note).toContain('400');
      expect(note).not.toContain('no total could be read');
    });

    it('flags a receipt filed when he recorded no amounts', async () => {
      await service.createFromTask({
        ...base,
        amountSpent: 2145.5,
        typedNetAmount: 0,
        scanned: scanned(),
      });

      const data = created().data;
      expect(data.needsReview).toBe(true);
      expect(String(data.reviewNote)).toContain('recorded no amounts');
    });
  });

  describe('approveEntry', () => {
    it('clears the flag and its note', async () => {
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(entryRow());

      await service.approveEntry(ENTRY_ID);

      expect(firstArg(prisma.pettyCashLedgerEntry.update)).toMatchObject({
        where: { id: ENTRY_ID },
        data: { needsReview: false, reviewNote: null },
      });
    });

    it('404s on an unknown entry', async () => {
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(null);

      await expect(service.approveEntry(ENTRY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.pettyCashLedgerEntry.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  //  Balance recomputation
  // --------------------------------------------------------------------------
  describe('createAdjustment', () => {
    beforeEach(() => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
      prisma.pettyCashLedgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: decimal(1000) },
      });
    });

    it('adds a TOP_UP to the remaining balance', async () => {
      prisma.pettyCashBalanceAdjustment.findMany.mockResolvedValue([
        {
          type: 'TOP_UP',
          amount: decimal(500),
          createdAt: new Date('2026-08-12T09:30:00.000Z'),
        },
      ]);

      await service.createAdjustment(
        2026,
        8,
        { type: 'TOP_UP', amount: 500, reason: 'Float' },
        ADMIN_ID,
      );

      const update = firstArg(prisma.pettyCashMonthlyLedger.update) as {
        data: {
          remainingBalance: Prisma.Decimal;
          totalExpenses: Prisma.Decimal;
        };
      };
      // 5000 opening + 500 top-up − 1000 spent
      expect(Number(update.data.remainingBalance)).toBe(4500);
      expect(Number(update.data.totalExpenses)).toBe(1000);
    });

    it('subtracts a CORRECTION from the remaining balance', async () => {
      prisma.pettyCashBalanceAdjustment.findMany.mockResolvedValue([
        {
          type: 'CORRECTION',
          amount: decimal(500),
          createdAt: new Date('2026-08-12T09:30:00.000Z'),
        },
      ]);

      await service.createAdjustment(
        2026,
        8,
        { type: 'CORRECTION', amount: 500, reason: 'Cash count short' },
        ADMIN_ID,
      );

      const update = firstArg(prisma.pettyCashMonthlyLedger.update) as {
        data: { remainingBalance: Prisma.Decimal };
      };
      // 5000 opening − 500 correction − 1000 spent
      expect(Number(update.data.remainingBalance)).toBe(3500);
    });
  });

  describe('closeMonth / reopenMonth', () => {
    it('closes an open month', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await service.closeMonth(2026, 8);

      expect(prisma.pettyCashMonthlyLedger.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isClosed: true } }),
      );
    });

    it('refuses to close a month that is already closed', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(
        ledgerRow({ isClosed: true }),
      );

      await expect(service.closeMonth(2026, 8)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.pettyCashMonthlyLedger.update).not.toHaveBeenCalled();
    });

    it('reopens a closed month, so a late settlement can still land', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(
        ledgerRow({ isClosed: true }),
      );

      await service.reopenMonth(2026, 8);

      expect(prisma.pettyCashMonthlyLedger.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isClosed: false } }),
      );
    });

    it('refuses to reopen a month that was never closed', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await expect(service.reopenMonth(2026, 8)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.pettyCashMonthlyLedger.update).not.toHaveBeenCalled();
    });

    it('404s for a month that was never opened', async () => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(null);

      await expect(service.closeMonth(2026, 8)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getMonthlySummary — adjustment totals', () => {
    beforeEach(() => {
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
      prisma.pettyCashLedgerEntry.count.mockResolvedValue(3);
    });

    it('reports top-ups and corrections separately, not netted', async () => {
      prisma.pettyCashBalanceAdjustment.findMany.mockResolvedValue([
        {
          type: 'TOP_UP',
          amount: decimal(10000),
          createdAt: new Date('2026-08-12T09:30:00.000Z'),
        },
        {
          type: 'CORRECTION',
          amount: decimal(2000),
          createdAt: new Date('2026-08-05T09:30:00.000Z'),
        },
      ]);

      const summary = await service.getMonthlySummary(2026, 8);

      // Netting these to +8000 would make the two indistinguishable from a
      // single top-up, which is exactly what the dashboard must not show.
      expect(summary.totalTopUps).toBe(10000);
      expect(summary.totalCorrections).toBe(2000);
      expect(summary.topUpCount).toBe(1);
      expect(summary.correctionCount).toBe(1);
    });

    it('reports the date of the most recent top-up, not the oldest', async () => {
      prisma.pettyCashBalanceAdjustment.findMany.mockResolvedValue([
        {
          type: 'TOP_UP',
          amount: decimal(4000),
          createdAt: new Date('2026-08-20T09:30:00.000Z'),
        },
        {
          type: 'TOP_UP',
          amount: decimal(6000),
          createdAt: new Date('2026-08-03T09:30:00.000Z'),
        },
      ]);

      const summary = await service.getMonthlySummary(2026, 8);

      expect(summary.totalTopUps).toBe(10000);
      expect(summary.topUpCount).toBe(2);
      expect(summary.lastTopUpAt).toBe('2026-08-20T09:30:00.000Z');
    });

    it('reports zero for a month with no adjustments', async () => {
      prisma.pettyCashBalanceAdjustment.findMany.mockResolvedValue([]);

      const summary = await service.getMonthlySummary(2026, 8);

      expect(summary.totalTopUps).toBe(0);
      expect(summary.totalCorrections).toBe(0);
      expect(summary.topUpCount).toBe(0);
      expect(summary.lastTopUpAt).toBeUndefined();
    });

    it('splits the entry count by source, and totals it from the split', async () => {
      prisma.pettyCashLedgerEntry.groupBy.mockResolvedValue([
        { source: 'TASK', _count: { _all: 61 } },
        { source: 'MANUAL', _count: { _all: 23 } },
      ]);

      const summary = await service.getMonthlySummary(2026, 8);

      expect(summary.entriesBySource).toEqual({ task: 61, manual: 23 });
      expect(summary.totalEntries).toBe(84);
    });

    it('reports when the month was opened', async () => {
      const summary = await service.getMonthlySummary(2026, 8);

      expect(summary.openedAt).toBe('2026-08-01T04:12:55.000Z');
    });
  });

  // --------------------------------------------------------------------------
  //  Receipt scanning
  // --------------------------------------------------------------------------
  describe('extractFromReceipt — upload validation', () => {
    it('rejects a missing file', async () => {
      await expect(
        service.extractFromReceipt(ADMIN_ID, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a file over the configured limit', async () => {
      await expect(
        service.extractFromReceipt(
          ADMIN_ID,
          uploadedFile({ size: 6 * 1024 * 1024 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('rejects a file whose declared mimetype lies about its bytes', async () => {
      // Declared as a PNG, but the bytes match nothing we accept. Trusting the
      // header here is how an unexpected file type gets into storage.
      const lying = uploadedFile({
        buffer: Buffer.alloc(32),
        mimetype: 'image/png',
        originalname: 'not-really.png',
      });

      await expect(
        service.extractFromReceipt(ADMIN_ID, lying),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('sends the sniffed type to storage and to the extractor', async () => {
      // Real JPEG bytes, mislabelled as a PDF. A PDF content block wrapping
      // JPEG bytes is rejected by the model API, so the sniffed type has to
      // reach the extractor too — not just storage.
      await service.extractFromReceipt(
        ADMIN_ID,
        uploadedFile({ mimetype: 'application/pdf' }),
      );

      const saved = callArg(storage.save, 0, 1) as { mimeType: string };
      expect(saved.mimeType).toBe('image/jpeg');
      expect(callArg(extractor.extract, 0, 1)).toBe('image/jpeg');
    });
  });

  // --------------------------------------------------------------------------
  //  Auto-create vs review
  // --------------------------------------------------------------------------
  describe('extractFromReceipt — auto-create threshold', () => {
    /** A confident, complete extraction — everything needed to file. */
    const goodExtraction = (overrides: Record<string, unknown> = {}) => ({
      amount: 2145.5,
      vendor: 'Shell Petrol',
      date: '2026-08-05',
      category: 'FUEL',
      description: 'Diesel, 32 litres',
      confidence: 0.95,
      ...overrides,
    });

    it('files the entry itself when confident and complete', async () => {
      extractor.extract.mockResolvedValue(goodExtraction());
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      const result = await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(result.status).toBe('AUTO_CREATED');
      expect(result.entry).toBeDefined();
      expect(result.uploadToken).toBeUndefined();
      // Nothing parked for review — the expense is already in the ledger.
      expect(prisma.pendingReceiptScan.create).not.toHaveBeenCalled();

      const created = firstArg(prisma.pettyCashLedgerEntry.create) as {
        data: Record<string, unknown>;
      };
      expect(created.data.amount).toBe(2145.5);
      expect(created.data.category).toBe('FUEL');
      expect(created.data.supplier).toBe('Shell Petrol');
      expect(created.data.description).toBe('Diesel, 32 litres');
      // The audit trail: an admin reading this row later can tell a machine
      // filed it, and how sure it was.
      expect(String(created.data.notes)).toContain('0.95');
    });

    it('parks the scan for review when confidence is below the threshold', async () => {
      extractor.extract.mockResolvedValue(goodExtraction({ confidence: 0.62 }));
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      const result = await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(result.status).toBe('NEEDS_REVIEW');
      expect(result.uploadToken).toMatch(/^upl_/);
      expect(result.reviewReason).toContain('0.62');
      expect(result.reviewReason).toContain('0.85');
      // The suggestions still come back — the admin corrects rather than retypes.
      expect(result.extracted.amount).toBe(2145.5);
      expect(result.extracted.category).toBe('FUEL');
      expect(prisma.pettyCashLedgerEntry.create).not.toHaveBeenCalled();
    });

    // Each of these is confident but unfilable. Guessing any of them would put
    // real money somewhere nobody chose.
    it.each([
      ['amount', { amount: undefined }, 'amount'],
      ['date', { date: undefined }, 'date'],
      ['category', { category: undefined }, 'category'],
    ])(
      'refuses to auto-file when the %s is missing',
      async (_label, override, expectedWord) => {
        extractor.extract.mockResolvedValue(goodExtraction(override));
        prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

        const result = await service.extractFromReceipt(
          ADMIN_ID,
          uploadedFile(),
        );

        expect(result.status).toBe('NEEDS_REVIEW');
        expect(result.reviewReason?.toLowerCase()).toContain(expectedWord);
        expect(prisma.pettyCashLedgerEntry.create).not.toHaveBeenCalled();
      },
    );

    it('refuses to auto-file into a month with no ledger open', async () => {
      extractor.extract.mockResolvedValue(goodExtraction());
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(null);

      const result = await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(result.status).toBe('NEEDS_REVIEW');
      expect(result.reviewReason).toContain('2026-08');
      expect(prisma.pettyCashLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('refuses to auto-file into a closed month', async () => {
      extractor.extract.mockResolvedValue(goodExtraction());
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(
        ledgerRow({ isClosed: true }),
      );

      const result = await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(result.status).toBe('NEEDS_REVIEW');
      expect(result.reviewReason).toContain('closed');
    });

    it('falls back to review when extraction is unavailable', async () => {
      // No API key, a model outage, or a refusal all arrive in this shape.
      extractor.extract.mockResolvedValue({
        confidence: 0,
        failureReason: 'Extraction is not configured.',
      });

      const result = await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(result.status).toBe('NEEDS_REVIEW');
      expect(result.reviewReason).toBe('Extraction is not configured.');
      expect(result.uploadToken).toMatch(/^upl_/);
      // The receipt is still stored, so the admin files it by hand rather than
      // being told to try again later.
      expect(storage.save).toHaveBeenCalled();
    });

    it('never auto-files a duplicate, however confident the extraction', async () => {
      // The whole point of the check: paying the same receipt twice outranks
      // any confidence score.
      extractor.extract.mockResolvedValue(goodExtraction({ confidence: 0.99 }));
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());
      duplicates.find.mockResolvedValue({
        matchType: 'IDENTICAL_FILE',
        entryId: 'entry-9',
        entryDate: '2026-08-05',
        amount: 2145.5,
        reason:
          'This exact receipt file is already attached to an entry dated 2026-08-05.',
      });

      const result = await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(result.status).toBe('NEEDS_REVIEW');
      expect(prisma.pettyCashLedgerEntry.create).not.toHaveBeenCalled();
      // The admin gets the existing entry to compare against, not just a "no".
      expect(result.duplicate?.entryId).toBe('entry-9');
      expect(result.reviewReason).toContain('already attached');
    });

    it('checks for duplicates using the hash of the uploaded bytes', async () => {
      await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(duplicates.hash).toHaveBeenCalled();
      expect(callArg(duplicates.find, 0, 0)).toBe('sha256-of-the-upload');
    });

    it('stores the hash on the pending scan so a re-upload can match it', async () => {
      await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      const row = firstArg(prisma.pendingReceiptScan.create) as {
        data: Record<string, unknown>;
      };
      expect(row.data.contentHash).toBe('sha256-of-the-upload');
    });

    it('stores the hash on an auto-filed receipt', async () => {
      extractor.extract.mockResolvedValue(goodExtraction());
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      const created = firstArg(prisma.pettyCashLedgerEntry.create) as {
        data: { receipt: { create: Record<string, unknown> } };
      };
      expect(created.data.receipt.create.contentHash).toBe(
        'sha256-of-the-upload',
      );
    });

    it('persists the scan to the database, not to process memory', async () => {
      extractor.extract.mockResolvedValue(goodExtraction({ confidence: 0.4 }));
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      const row = firstArg(prisma.pendingReceiptScan.create) as {
        data: Record<string, unknown>;
      };
      expect(row.data.uploadToken).toMatch(/^upl_/);
      expect(row.data.uploadedById).toBe(ADMIN_ID);
      expect(row.data.confidence).toBe(0.4);
      expect(row.data.suggestedCategory).toBe('FUEL');
      expect(row.data.expiresAt).toBeInstanceOf(Date);
    });
  });

  describe('confirmScanEntry', () => {
    const dto = {
      amount: 100,
      supplier: 'Shell',
      category: 'FUEL' as const,
      entryDate: '2026-08-05',
    };

    const pendingRow = {
      id: 'scan-1',
      uploadToken: 'upl_abc',
      storageKey: 'petty-cash-receipts/2026/08/x.jpg',
      originalName: 'receipt.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 24,
      extractedAmount: decimal(100),
      extractedVendor: 'Shell',
      extractedDate: new Date('2026-08-05T00:00:00.000Z'),
    };

    it('rejects an unknown token', async () => {
      prisma.pendingReceiptScan.findUnique.mockResolvedValue(null);

      await expect(
        service.confirmScanEntry('upl_nope', dto, ADMIN_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('consumes the token in the same transaction as the entry', async () => {
      prisma.pendingReceiptScan.findUnique.mockResolvedValue(pendingRow);
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await service.confirmScanEntry('upl_abc', dto, ADMIN_ID);

      // Both writes go through the one $transaction callback, so a failed entry
      // write rolls the token back and the admin can confirm the same upload
      // again rather than re-scanning the receipt.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.pendingReceiptScan.delete).toHaveBeenCalledWith({
        where: { id: 'scan-1' },
      });
    });

    it('keeps the raw extraction on the receipt for audit', async () => {
      prisma.pendingReceiptScan.findUnique.mockResolvedValue(pendingRow);
      prisma.pettyCashMonthlyLedger.findUnique.mockResolvedValue(ledgerRow());

      await service.confirmScanEntry('upl_abc', dto, ADMIN_ID);

      const created = firstArg(prisma.pettyCashLedgerEntry.create) as {
        data: { receipt: { create: Record<string, unknown> } };
      };
      expect(created.data.receipt.create.extractedVendor).toBe('Shell');
      expect(created.data.receipt.create.storageKey).toBe(
        pendingRow.storageKey,
      );
    });
  });

  describe('sweepExpiredScans', () => {
    it('deletes expired rows and their orphaned files', async () => {
      prisma.pendingReceiptScan.findMany.mockResolvedValue([
        { id: 'scan-old', storageKey: 'petty-cash-receipts/2026/07/old.jpg' },
      ]);

      await service.extractFromReceipt(ADMIN_ID, uploadedFile());

      expect(prisma.pendingReceiptScan.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['scan-old'] } },
      });
      expect(storage.delete).toHaveBeenCalledWith(
        'petty-cash-receipts/2026/07/old.jpg',
      );
    });

    it('does not fail the upload when cleanup of an old file fails', async () => {
      prisma.pendingReceiptScan.findMany.mockResolvedValue([
        { id: 'scan-old', storageKey: 'gone.jpg' },
      ]);
      storage.delete.mockRejectedValue(new Error('bucket unreachable'));

      await expect(
        service.extractFromReceipt(ADMIN_ID, uploadedFile()),
      ).resolves.toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  //  Deleting
  // --------------------------------------------------------------------------
  describe('deleteEntry', () => {
    it('404s on an unknown entry without deleting anything', async () => {
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(null);

      await expect(service.deleteEntry(ENTRY_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.pettyCashLedgerEntry.delete).not.toHaveBeenCalled();
    });

    it('recomputes the month totals after removing the row', async () => {
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(entryRow());

      await service.deleteEntry(ENTRY_ID);

      expect(prisma.pettyCashLedgerEntry.delete).toHaveBeenCalled();
      expect(prisma.pettyCashMonthlyLedger.update).toHaveBeenCalled();
    });
  });
});
