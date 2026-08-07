import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  CreateManualEntryDto,
  ConfirmScanEntryDto,
  UpdateEntryDto,
  QueryLedgerDto,
  SetOpeningBalanceDto,
  CreateAdjustmentDto,
  LedgerEntryResponseDto,
  PaginatedLedgerResponseDto,
  MonthlySummaryResponseDto,
  ScanExtractionResponseDto,
} from './dto';
import {
  LedgerEntrySource,
  OpeningBalanceSource,
} from './petty-cash.constants';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** In-memory holding area for uploaded-but-unconfirmed receipt scans. In a
 *  multi-instance deployment this MUST move to Redis or the DB with a TTL —
 *  see "Recommendations" in the module documentation. For 6-7 concurrent
 *  office boys and a single admin panel, an in-process map with a timeout
 *  is a deliberate, documented simplification, not an oversight.
 */
interface PendingScan {
  storageKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  extractedAmount?: number;
  extractedVendor?: string;
  extractedDate?: string;
  expiresAt: number;
}

@Injectable()
export class PettyCashService {
  private readonly pendingScans = new Map<string, PendingScan>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  // --------------------------------------------------------------------
  //  Monthly ledger lifecycle
  // --------------------------------------------------------------------

  /**
   * Opens a month's ledger. This is the single entry point for both the
   * "carry forward" and "manually define" flows from the admin UI —
   * distinguished purely by whether `dto.amount` was supplied.
   *
   * Throws ConflictException if the month is already open — re-opening an
   * existing month is not a thing; use adjustments to correct it instead.
   */
  async openMonth(dto: SetOpeningBalanceDto, adminId: string): Promise<MonthlySummaryResponseDto> {
    const existing = await this.prisma.pettyCashMonthlyLedger.findUnique({
      where: { year_month: { year: dto.year, month: dto.month } },
    });
    if (existing) {
      throw new ConflictException(
        `Ledger for ${dto.year}-${String(dto.month).padStart(2, '0')} is already open.`,
      );
    }

    let openingBalance: Prisma.Decimal | number;
    let openingBalanceSource: OpeningBalanceSource;

    if (dto.amount !== undefined) {
      openingBalance = dto.amount;
      openingBalanceSource = OpeningBalanceSource.MANUAL;
    } else {
      const previous = await this.findPreviousMonth(dto.year, dto.month);
      if (!previous) {
        throw new BadRequestException(
          'No previous month found to carry forward from. Supply `amount` to set an opening balance manually.',
        );
      }
      openingBalance = previous.remainingBalance;
      openingBalanceSource = OpeningBalanceSource.CARRY_FORWARD;

      // Close the previous month now that its balance has been carried
      // forward. A month can still be edited by an admin after closing
      // (corrections happen after month-end) — closing only stops new
      // task-derived entries from landing in it. See docs.
      await this.prisma.pettyCashMonthlyLedger.update({
        where: { id: previous.id },
        data: { isClosed: true },
      });
    }

    const created = await this.prisma.pettyCashMonthlyLedger.create({
      data: {
        year: dto.year,
        month: dto.month,
        openingBalance,
        openingBalanceSource,
        remainingBalance: openingBalance,
        totalExpenses: 0,
        note: dto.note,
        setById: adminId,
      },
    });

    return this.toMonthlySummaryDto(created, 0);
  }

  async getMonthlySummary(year: number, month: number): Promise<MonthlySummaryResponseDto> {
    const ledger = await this.requireMonth(year, month);
    const totalEntries = await this.prisma.pettyCashLedgerEntry.count({
      where: { monthlyLedgerId: ledger.id },
    });
    return this.toMonthlySummaryDto(ledger, totalEntries);
  }

  private async findPreviousMonth(year: number, month: number) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    return this.prisma.pettyCashMonthlyLedger.findUnique({
      where: { year_month: { year: prevYear, month: prevMonth } },
    });
  }

  private async requireMonth(year: number, month: number) {
    const ledger = await this.prisma.pettyCashMonthlyLedger.findUnique({
      where: { year_month: { year, month } },
    });
    if (!ledger) {
      throw new NotFoundException(
        `No petty cash ledger open for ${year}-${String(month).padStart(2, '0')}. An admin must open it first (carry-forward or manual opening balance).`,
      );
    }
    return ledger;
  }

  // --------------------------------------------------------------------
  //  Entries — listing
  // --------------------------------------------------------------------

  async listEntries(query: QueryLedgerDto): Promise<PaginatedLedgerResponseDto> {
    const year = query.year ?? new Date().getUTCFullYear();
    const where: Prisma.PettyCashLedgerEntryWhereInput = {};

    if (query.month) {
      const ledger = await this.prisma.pettyCashMonthlyLedger.findUnique({
        where: { year_month: { year, month: query.month } },
      });
      // No ledger opened yet for that month = no entries, not an error;
      // the dashboard should render an empty state, not a 404.
      if (!ledger) {
        return { data: [], page: query.page ?? 1, pageSize: query.pageSize ?? 20, totalCount: 0 };
      }
      where.monthlyLedgerId = ledger.id;
    } else {
      where.monthlyLedger = { year };
    }

    if (query.source) where.source = query.source;
    if (query.category) where.category = query.category;
    if (query.staffId) where.staffId = query.staffId;
    if (query.dateFrom || query.dateTo) {
      where.entryDate = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { description: { contains: query.search, mode: 'insensitive' } },
        { supplier: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [rows, totalCount] = await this.prisma.$transaction([
      this.prisma.pettyCashLedgerEntry.findMany({
        where,
        include: this.entryInclude(),
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.pettyCashLedgerEntry.count({ where }),
    ]);

    // Running balance is computed here, over the full (unpaginated) set for
    // whichever month is in view, oldest-first, then reversed to match the
    // newest-first display order. See module docs, "Balance calculation
    // logic" for why this is never persisted per-row.
    const runningBalances = await this.computeRunningBalances(where);

    const data = rows.map(
      (row) => new LedgerEntryResponseDto(this.mapEntry(row, runningBalances.get(row.id) ?? 0)),
    );

    return { data, page, pageSize, totalCount };
  }

  private async computeRunningBalances(
    where: Prisma.PettyCashLedgerEntryWhereInput,
  ): Promise<Map<string, number>> {
    const all = await this.prisma.pettyCashLedgerEntry.findMany({
      where,
      select: { id: true, amount: true, entryDate: true, createdAt: true, monthlyLedgerId: true },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
    });
    if (all.length === 0) return new Map();

    const ledgerIds = [...new Set(all.map((e) => e.monthlyLedgerId))];
    const ledgers = await this.prisma.pettyCashMonthlyLedger.findMany({
      where: { id: { in: ledgerIds } },
      select: { id: true, openingBalance: true },
    });
    const openingByLedger = new Map(ledgers.map((l) => [l.id, Number(l.openingBalance)]));

    const running = new Map<string, number>();
    const runningTotals = new Map<string, number>();
    for (const entry of all) {
      const opening = openingByLedger.get(entry.monthlyLedgerId) ?? 0;
      const prevTotal = runningTotals.get(entry.monthlyLedgerId) ?? opening;
      const next = prevTotal - Number(entry.amount);
      runningTotals.set(entry.monthlyLedgerId, next);
      running.set(entry.id, next);
    }
    return running;
  }

  private entryInclude() {
    return {
      staff: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      receipt: true,
      task: { include: { receipt: true } },
    } satisfies Prisma.PettyCashLedgerEntryInclude;
  }

  // --------------------------------------------------------------------
  //  Receipt download
  // --------------------------------------------------------------------

  /**
   * Backs `GET /petty-cash/entries/:id/receipt`. Resolves whichever receipt
   * actually belongs to this entry — a MANUAL entry's own PettyCashReceipt,
   * or a TASK entry's TaskReceipt via the linked task — and streams it
   * straight from the storage driver. StorageService is stream-based (no
   * signed-URL support), so this endpoint IS the "url" returned by
   * mapEntry() rather than a pass-through to a storage-provider link.
   */
  async getReceiptStream(
    entryId: string,
  ): Promise<{ stream: Readable; mimeType: string; originalName: string }> {
    const entry = await this.prisma.pettyCashLedgerEntry.findUnique({
      where: { id: entryId },
      include: { receipt: true, task: { include: { receipt: true } } },
    });
    if (!entry) throw new NotFoundException('Ledger entry not found.');

    const receipt = entry.receipt ?? entry.task?.receipt;
    if (!receipt) throw new NotFoundException('This entry has no receipt attached.');

    const stream = await this.storage.createReadStream(receipt.storageKey);
    return { stream, mimeType: receipt.mimeType, originalName: receipt.originalName };
  }

  private mapEntry(row: any, runningBalance: number): Partial<LedgerEntryResponseDto> {
    const taskReceipt = row.task?.receipt;
    const manualReceipt = row.receipt;
    const receipt = manualReceipt ?? taskReceipt;

    return {
      id: row.id,
      source: row.source,
      amount: Number(row.amount),
      category: row.category,
      description: row.description,
      supplier: row.supplier ?? undefined,
      entryDate: row.entryDate.toISOString().slice(0, 10),
      month: MONTH_NAMES[row.entryDate.getUTCMonth()],
      paymentMethod: row.paymentMethod,
      staff: row.staff ? { id: row.staff.id, name: row.staff.name } : undefined,
      taskId: row.taskId ?? undefined,
      notes: row.notes ?? undefined,
      receipt: receipt
        ? {
            id: receipt.id,
            url: `/petty-cash/entries/${row.id}/receipt`,
            mimeType: receipt.mimeType,
          }
        : undefined,
      runningBalance,
      createdBy: { id: row.createdBy.id, name: row.createdBy.name },
      createdAt: row.createdAt.toISOString(),
    };
  }

  // --------------------------------------------------------------------
  //  Entries — manual creation (Admin)
  // --------------------------------------------------------------------

  async createManualEntry(dto: CreateManualEntryDto, adminId: string): Promise<LedgerEntryResponseDto> {
    const entryDate = new Date(dto.entryDate);
    const ledger = await this.requireMonth(entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1);

    const created = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.pettyCashLedgerEntry.create({
        data: {
          monthlyLedgerId: ledger.id,
          source: LedgerEntrySource.MANUAL,
          amount: dto.amount,
          category: dto.category,
          description: dto.description,
          supplier: dto.supplier,
          entryDate,
          paymentMethod: dto.paymentMethod,
          staffId: dto.staffId,
          taskId: dto.linkedTaskId,
          notes: dto.notes,
          createdById: adminId,
        },
        include: this.entryInclude(),
      });
      await this.recomputeLedgerTotals(ledger.id, tx);
      return entry;
    });

    const runningBalances = await this.computeRunningBalances({ monthlyLedgerId: ledger.id });
    return new LedgerEntryResponseDto(this.mapEntry(created, runningBalances.get(created.id) ?? 0));
  }

  // --------------------------------------------------------------------
  //  Entries — automatic creation from a completed Task
  // --------------------------------------------------------------------

  /**
   * Called by the Task module's `POST /tasks/:id/submit` handler, never
   * exposed as a public HTTP endpoint of this module. This is the
   * integration point mentioned in the module documentation's "Data
   * flow" section.
   *
   * Idempotent by construction: `PettyCashLedgerEntry.taskId` is unique,
   * and the Task module only calls this once (`Task.submittedAt` being
   * already set is what the Task module checks before calling). If it is
   * somehow called twice for the same task, this throws rather than
   * silently duplicating a financial record.
   */
  async createFromTask(params: {
    taskId: string;
    officeBoyId: string;
    amountSpent: number;
    vendorDetails?: string;
    description: string;
    entryDate: Date;
  }): Promise<LedgerEntryResponseDto> {
    const existing = await this.prisma.pettyCashLedgerEntry.findUnique({
      where: { taskId: params.taskId },
    });
    if (existing) {
      throw new ConflictException(`Task ${params.taskId} has already been settled into the petty cash ledger.`);
    }

    const ledger = await this.requireMonth(
      params.entryDate.getUTCFullYear(),
      params.entryDate.getUTCMonth() + 1,
    );
    if (ledger.isClosed) {
      throw new BadRequestException(
        `Petty cash ledger for ${ledger.year}-${String(ledger.month).padStart(2, '0')} is closed. An admin must reopen it or record this as a manual entry with an adjustment.`,
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.pettyCashLedgerEntry.create({
        data: {
          monthlyLedgerId: ledger.id,
          source: LedgerEntrySource.TASK,
          amount: params.amountSpent,
          category: 'MISCELLANEOUS', // Task-derived entries have no category input in the office-boy flow; an admin recategorises from the ledger table if needed. See "Assumptions" in docs.
          description: params.description,
          supplier: params.vendorDetails,
          entryDate: params.entryDate,
          paymentMethod: 'PETTY_CASH',
          staffId: params.officeBoyId,
          taskId: params.taskId,
          createdById: params.officeBoyId,
        },
        include: this.entryInclude(),
      });
      await this.recomputeLedgerTotals(ledger.id, tx);
      return entry;
    });

    const runningBalances = await this.computeRunningBalances({ monthlyLedgerId: ledger.id });
    return new LedgerEntryResponseDto(this.mapEntry(created, runningBalances.get(created.id) ?? 0));
  }

  // --------------------------------------------------------------------
  //  Entries — scan receipt flow
  // --------------------------------------------------------------------

  async extractFromReceipt(file: Express.Multer.File): Promise<ScanExtractionResponseDto> {
    if (!file) throw new BadRequestException('No file uploaded.');
    const allowed = ['image/png', 'image/jpeg', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Only PNG, JPG, or PDF receipts are accepted.');
    }
    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new BadRequestException('Receipt file exceeds the 5MB limit.');
    }

    const stored = await this.storage.save(file.buffer, {
      mimeType: file.mimetype,
      originalName: file.originalname,
      namespace: 'petty-cash-receipts',
    });
    const storageKey = stored.key;
    const uploadToken = `upl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    // OCR extraction is a placeholder — plug in the actual OCR/vision
    // provider here. Left unimplemented deliberately: it's an external
    // integration decision outside the scope of the ledger's data model,
    // and stubbing it keeps this module runnable/testable without that
    // dependency. See "Recommendations" in the docs.
    const extraction = await this.runOcrStub(file);

    this.pendingScans.set(uploadToken, {
      storageKey,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      ...extraction,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });

    return new ScanExtractionResponseDto({
      uploadToken,
      extractedAmount: extraction.extractedAmount,
      extractedVendor: extraction.extractedVendor,
      extractedDate: extraction.extractedDate,
      suggestedCategory: undefined,
      confidence: extraction.extractedAmount ? 0.8 : 0.2,
    });
  }

  private async runOcrStub(_file: Express.Multer.File) {
    return {
      extractedAmount: undefined as number | undefined,
      extractedVendor: undefined as string | undefined,
      extractedDate: undefined as string | undefined,
    };
  }

  async confirmScanEntry(
    uploadToken: string,
    dto: ConfirmScanEntryDto,
    adminId: string,
  ): Promise<LedgerEntryResponseDto> {
    const pending = this.pendingScans.get(uploadToken);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new NotFoundException('Upload token not found or expired. Re-upload the receipt.');
    }

    const entryDate = new Date(dto.entryDate);
    const ledger = await this.requireMonth(entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1);

    const created = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.pettyCashLedgerEntry.create({
        data: {
          monthlyLedgerId: ledger.id,
          source: LedgerEntrySource.MANUAL,
          amount: dto.amount,
          category: dto.category,
          description: dto.description ?? dto.supplier,
          supplier: dto.supplier,
          entryDate,
          paymentMethod: dto.paymentMethod,
          staffId: dto.staffId,
          notes: dto.notes,
          createdById: adminId,
          receipt: {
            create: {
              storageKey: pending.storageKey,
              originalName: pending.originalName,
              mimeType: pending.mimeType,
              sizeBytes: pending.sizeBytes,
              extractedAmount: pending.extractedAmount,
              extractedVendor: pending.extractedVendor,
              extractedDate: pending.extractedDate ? new Date(pending.extractedDate) : undefined,
            },
          },
        },
        include: this.entryInclude(),
      });
      await this.recomputeLedgerTotals(ledger.id, tx);
      return entry;
    });

    this.pendingScans.delete(uploadToken);

    const runningBalances = await this.computeRunningBalances({ monthlyLedgerId: ledger.id });
    return new LedgerEntryResponseDto(this.mapEntry(created, runningBalances.get(created.id) ?? 0));
  }

  // --------------------------------------------------------------------
  //  Entries — update / delete (Admin)
  // --------------------------------------------------------------------

  async updateEntry(id: string, dto: UpdateEntryDto): Promise<LedgerEntryResponseDto> {
    const existing = await this.prisma.pettyCashLedgerEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Ledger entry ${id} not found.`);

    const entryDate = dto.entryDate ? new Date(dto.entryDate) : existing.entryDate;
    const targetLedger = await this.requireMonth(entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1);

    const affectedLedgerIds = new Set([existing.monthlyLedgerId, targetLedger.id]);

    const updated = await this.prisma.$transaction(async (tx) => {
      const entry = await tx.pettyCashLedgerEntry.update({
        where: { id },
        data: {
          amount: dto.amount,
          category: dto.category,
          description: dto.description,
          supplier: dto.supplier,
          entryDate: dto.entryDate ? entryDate : undefined,
          paymentMethod: dto.paymentMethod,
          staffId: dto.staffId,
          notes: dto.notes,
          monthlyLedgerId: targetLedger.id,
        },
        include: this.entryInclude(),
      });
      for (const ledgerId of affectedLedgerIds) {
        await this.recomputeLedgerTotals(ledgerId, tx);
      }
      return entry;
    });

    const runningBalances = await this.computeRunningBalances({ monthlyLedgerId: targetLedger.id });
    return new LedgerEntryResponseDto(this.mapEntry(updated, runningBalances.get(updated.id) ?? 0));
  }

  async deleteEntry(id: string): Promise<void> {
    const existing = await this.prisma.pettyCashLedgerEntry.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Ledger entry ${id} not found.`);

    await this.prisma.$transaction(async (tx) => {
      await tx.pettyCashLedgerEntry.delete({ where: { id } });
      await this.recomputeLedgerTotals(existing.monthlyLedgerId, tx);
    });
  }

  // --------------------------------------------------------------------
  //  Adjustments
  // --------------------------------------------------------------------

  async createAdjustment(
    year: number,
    month: number,
    dto: CreateAdjustmentDto,
    adminId: string,
  ): Promise<MonthlySummaryResponseDto> {
    const ledger = await this.requireMonth(year, month);

    await this.prisma.$transaction(async (tx) => {
      await tx.pettyCashBalanceAdjustment.create({
        data: {
          monthlyLedgerId: ledger.id,
          type: dto.type,
          amount: dto.amount,
          reason: dto.reason,
          createdById: adminId,
        },
      });
      await this.recomputeLedgerTotals(ledger.id, tx);
    });

    return this.getMonthlySummary(year, month);
  }

  // --------------------------------------------------------------------
  //  Balance recomputation
  // --------------------------------------------------------------------

  /**
   * The single source of truth for `totalExpenses` and `remainingBalance`
   * on a monthly ledger. Called inside every transaction that writes an
   * entry or adjustment against that ledger, so the cached totals can
   * never drift from the underlying rows. See "Balance calculation
   * logic" in the module documentation.
   */
  private async recomputeLedgerTotals(monthlyLedgerId: string, tx: Prisma.TransactionClient) {
    const ledger = await tx.pettyCashMonthlyLedger.findUniqueOrThrow({
      where: { id: monthlyLedgerId },
    });

    const expenseAgg = await tx.pettyCashLedgerEntry.aggregate({
      where: { monthlyLedgerId },
      _sum: { amount: true },
    });
    const totalExpenses = expenseAgg._sum.amount ?? new Prisma.Decimal(0);

    const adjustments = await tx.pettyCashBalanceAdjustment.findMany({
      where: { monthlyLedgerId },
      select: { type: true, amount: true },
    });
    const netAdjustments = adjustments.reduce<Prisma.Decimal>((sum, adj) => {
      const signed = adj.type === 'TOP_UP' ? adj.amount : adj.amount.negated();
      return sum.plus(signed);
    }, new Prisma.Decimal(0));

    const remainingBalance = new Prisma.Decimal(ledger.openingBalance)
      .plus(netAdjustments)
      .minus(totalExpenses);

    await tx.pettyCashMonthlyLedger.update({
      where: { id: monthlyLedgerId },
      data: { totalExpenses, remainingBalance },
    });
  }

  private toMonthlySummaryDto(
    ledger: {
      id: string;
      year: number;
      month: number;
      openingBalance: Prisma.Decimal;
      openingBalanceSource: string;
      totalExpenses: Prisma.Decimal;
      remainingBalance: Prisma.Decimal;
      isClosed: boolean;
      note: string | null;
    },
    totalEntries: number,
  ): MonthlySummaryResponseDto {
    return new MonthlySummaryResponseDto({
      id: ledger.id,
      year: ledger.year,
      month: ledger.month,
      openingBalance: Number(ledger.openingBalance),
      openingBalanceSource: ledger.openingBalanceSource as OpeningBalanceSource,
      totalExpenses: Number(ledger.totalExpenses),
      remainingBalance: Number(ledger.remainingBalance),
      totalEntries,
      isClosed: ledger.isClosed,
      note: ledger.note ?? undefined,
    });
  }
}