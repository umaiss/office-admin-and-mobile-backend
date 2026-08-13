import { Test, TestingModule } from '@nestjs/testing';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { firstArg } from '../common/testing/mock-args';
import { ReceiptDuplicateService } from './receipt-duplicate.service';
import type { ReceiptExtraction } from './receipt-extraction.service';

/**
 * Recognising a receipt that has already been filed.
 *
 * Two things are worth pinning here. First, that a receipt reaching the ledger
 * through an office boy's task is matched just as readily as one scanned by the
 * admin — the same photo sent down both routes is still one expense, and only
 * checking one table would miss exactly that. Second, that the looser
 * vendor/amount/date match stays loose enough to be useful and strict enough to
 * be trusted: it needs all three fields, or it does not fire.
 */
describe('ReceiptDuplicateService', () => {
  let service: ReceiptDuplicateService;
  let prisma: {
    pettyCashReceipt: { findFirst: jest.Mock };
    taskReceipt: { findFirst: jest.Mock };
    pendingReceiptScan: { findFirst: jest.Mock };
    pettyCashLedgerEntry: { findUnique: jest.Mock; findFirst: jest.Mock };
  };

  const HASH = 'a'.repeat(64);

  const entrySummary = (overrides: Record<string, unknown> = {}) => ({
    id: 'entry-1',
    entryDate: new Date('2026-08-05T00:00:00.000Z'),
    amount: new Prisma.Decimal(2145.5),
    supplier: 'Shell Petrol Station',
    ...overrides,
  });

  const extraction = (
    overrides: Partial<ReceiptExtraction> = {},
  ): ReceiptExtraction => ({
    amount: 2145.5,
    vendor: 'Shell Petrol Station',
    date: '2026-08-05',
    confidence: 0.9,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      pettyCashReceipt: { findFirst: jest.fn().mockResolvedValue(null) },
      taskReceipt: { findFirst: jest.fn().mockResolvedValue(null) },
      pendingReceiptScan: { findFirst: jest.fn().mockResolvedValue(null) },
      pettyCashLedgerEntry: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReceiptDuplicateService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<ReceiptDuplicateService>(ReceiptDuplicateService);
  });

  describe('hash', () => {
    it('is stable for the same bytes and different for different bytes', () => {
      const a = service.hash(Buffer.from('receipt bytes'));
      const b = service.hash(Buffer.from('receipt bytes'));
      const c = service.hash(Buffer.from('other bytes'));

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('no match', () => {
    it('returns null when nothing on file resembles this receipt', async () => {
      await expect(service.find(HASH, extraction())).resolves.toBeNull();
    });
  });

  describe('identical file', () => {
    it('matches a receipt already attached to a ledger entry', async () => {
      prisma.pettyCashReceipt.findFirst.mockResolvedValue({
        ledgerEntry: entrySummary(),
      });

      const match = await service.find(HASH, extraction());

      expect(match).toMatchObject({
        matchType: 'IDENTICAL_FILE',
        entryId: 'entry-1',
        entryDate: '2026-08-05',
        amount: 2145.5,
      });
      expect(match?.reason).toContain('2026-08-05');
    });

    it("matches a receipt filed through an office boy's task", async () => {
      // The same photo can reach the ledger through either route; checking only
      // the admin's table would miss the crossover case entirely.
      prisma.taskReceipt.findFirst.mockResolvedValue({ taskId: 'task-7' });
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(
        entrySummary({ id: 'entry-from-task' }),
      );

      const match = await service.find(HASH, extraction());

      expect(match?.matchType).toBe('IDENTICAL_FILE');
      expect(match?.entryId).toBe('entry-from-task');
      expect(firstArg(prisma.pettyCashLedgerEntry.findUnique)).toMatchObject({
        where: { taskId: 'task-7' },
      });
    });

    it('ignores a task receipt whose task never reached the ledger', async () => {
      // An unsubmitted task has taken no money out of petty cash, so its
      // receipt is not yet a duplicate of anything.
      prisma.taskReceipt.findFirst.mockResolvedValue({ taskId: 'task-7' });
      prisma.pettyCashLedgerEntry.findUnique.mockResolvedValue(null);

      await expect(service.find(HASH, extraction())).resolves.toBeNull();
    });
  });

  describe('pending scan', () => {
    it('matches the same file already uploaded and awaiting confirmation', async () => {
      prisma.pendingReceiptScan.findFirst.mockResolvedValue({
        createdAt: new Date(),
      });

      const match = await service.find(HASH, extraction());

      expect(match?.matchType).toBe('PENDING_SCAN');
      // Nothing to link to — it is not an entry yet.
      expect(match?.entryId).toBeUndefined();
    });

    it('ignores an expired pending scan', async () => {
      await service.find(HASH, extraction());

      const where = firstArg(prisma.pendingReceiptScan.findFirst) as {
        where: { expiresAt: { gt: Date } };
      };
      expect(where.where.expiresAt.gt).toBeInstanceOf(Date);
    });
  });

  describe('vendor + amount + date', () => {
    it('matches a different photo of an already-filed expense', async () => {
      prisma.pettyCashLedgerEntry.findFirst.mockResolvedValue(entrySummary());

      const match = await service.find(HASH, extraction());

      expect(match?.matchType).toBe('SAME_VENDOR_AMOUNT_DATE');
      expect(match?.entryId).toBe('entry-1');
      expect(match?.reason).toContain('Shell Petrol Station');
    });

    it('matches the vendor case-insensitively', async () => {
      prisma.pettyCashLedgerEntry.findFirst.mockResolvedValue(entrySummary());

      await service.find(HASH, extraction({ vendor: 'shell petrol station' }));

      const args = firstArg(prisma.pettyCashLedgerEntry.findFirst) as {
        where: { supplier: { mode: string } };
      };
      expect(args.where.supplier.mode).toBe('insensitive');
    });

    it.each([
      ['no vendor', { vendor: undefined }],
      ['no amount', { amount: undefined }],
      ['no date', { date: undefined }],
    ])('does not fire with %s', async (_label, override) => {
      // Two runs to the same shop on one day for different amounts must not
      // flag each other — all three fields or nothing.
      await expect(
        service.find(HASH, extraction(override)),
      ).resolves.toBeNull();
      expect(prisma.pettyCashLedgerEntry.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('precedence', () => {
    it('reports the certain match when both kinds are present', async () => {
      // An identical file is proof; matching details are only strong evidence.
      // The admin gets the more useful message.
      prisma.pettyCashReceipt.findFirst.mockResolvedValue({
        ledgerEntry: entrySummary(),
      });
      prisma.pettyCashLedgerEntry.findFirst.mockResolvedValue(entrySummary());

      const match = await service.find(HASH, extraction());

      expect(match?.matchType).toBe('IDENTICAL_FILE');
      // The looser query is never even run.
      expect(prisma.pettyCashLedgerEntry.findFirst).not.toHaveBeenCalled();
    });
  });
});
