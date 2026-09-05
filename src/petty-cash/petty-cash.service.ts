import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { buildPaginationMeta } from '../common/pagination/paginate';
import { AppConfigService } from '../config/app-config.service';
import { Prisma } from '../generated/prisma/client';
import {
  AdjustmentType,
  LedgerEntrySource,
  OpeningBalanceSource,
  PettyCashCategory,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALLOWED_RECEIPT_MIME_TYPES,
  sniffMimeType,
} from '../storage/file-type';
import { StorageService } from '../storage/storage.service';
import {
  ConfirmScanEntryDto,
  CreateAdjustmentDto,
  CreateManualEntryDto,
  ExtractedReceiptFieldsDto,
  LedgerEntryResponseDto,
  MonthlySummaryResponseDto,
  PaginatedLedgerResponseDto,
  QueryLedgerDto,
  ScanExtractionResponseDto,
  SetOpeningBalanceDto,
  UpdateEntryDto,
} from './dto';
import { ReceiptDuplicateService } from './receipt-duplicate.service';
import {
  ReceiptExtraction,
  ReceiptExtractionService,
} from './receipt-extraction.service';
import { escapeLike } from '../common/search/escape-like';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** How long an uploaded-but-unconfirmed scan stays claimable. */
const SCAN_TTL_MS = 30 * 60 * 1000;

/**
 * How far the receipt total and the office boy's own figure may drift before
 * an admin is asked to look.
 *
 * One rupee, not zero: a receipt rounded to the rupee against a figure entered
 * to the paisa would otherwise flag every single task, and a queue that flags
 * everything gets ignored — which costs more than the rupee it was protecting.
 */
const AMOUNT_TOLERANCE = 1;

/**
 * What the Task module hands over when an office boy submits a settled task.
 *
 * `amountSpent` is what gets filed; `typedNetAmount` is what he entered by
 * hand. They are separate fields precisely so the two can be compared — when a
 * receipt was read, `amountSpent` comes from the receipt and the typed figure
 * becomes the cross-check.
 */
export interface TaskEntryParams {
  taskId: string;
  officeBoyId: string;
  /** The amount actually filed — the receipt's total when one was read. */
  amountSpent: number;
  /** `amountReceived - amountReturned`, as the office boy recorded it. */
  typedNetAmount: number;
  vendorDetails?: string;
  description: string;
  entryDate: Date;
  /** What the extractor read off his receipt at upload. Absent if no receipt. */
  scanned?: {
    amount?: number;
    vendor?: string;
    date?: string;
    category?: PettyCashCategory;
    description?: string;
    confidence: number;
    failureReason?: string;
  };
}

/**
 * Every relation a ledger entry response needs, declared once.
 *
 * Hoisted to module scope (rather than returned from a method) so the row type
 * below can be derived from it. That derivation is what lets `mapEntry` take a
 * precisely-typed row instead of `any` — the previous shape defeated every
 * type check inside the mapper, which is exactly where a wrong field name would
 * otherwise slip through to the client.
 */
const ENTRY_INCLUDE = {
  staff: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  receipt: true,
  task: { include: { receipt: true } },
} satisfies Prisma.PettyCashLedgerEntryInclude;

type LedgerEntryRow = Prisma.PettyCashLedgerEntryGetPayload<{
  include: typeof ENTRY_INCLUDE;
}>;

/**
 * Either the injected client or a transaction client.
 *
 * Every private helper takes one of these rather than reaching for
 * `this.prisma`, so the same code can run standalone or as part of a caller's
 * transaction. `createFromTask` depends on this: the Task module needs the
 * ledger write to commit or roll back together with its own.
 */
type Db = Prisma.TransactionClient;

@Injectable()
export class PettyCashService {
  private readonly logger = new Logger(PettyCashService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: AppConfigService,
    private readonly extractor: ReceiptExtractionService,
    private readonly duplicates: ReceiptDuplicateService,
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
   *
   * The whole thing runs in one transaction because the carry-forward path
   * writes twice: it closes the previous month and then opens this one. Split
   * across two statements, a failure between them leaves the previous month
   * closed with nothing carried forward — a state no route can undo.
   */
  async openMonth(
    dto: SetOpeningBalanceDto,
    adminId: string,
  ): Promise<MonthlySummaryResponseDto> {
    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pettyCashMonthlyLedger.findUnique({
        where: { year_month: { year: dto.year, month: dto.month } },
      });
      if (existing) {
        throw new ConflictException(
          `Ledger for ${formatMonth(dto.year, dto.month)} is already open.`,
        );
      }

      let openingBalance: Prisma.Decimal | number;
      let openingBalanceSource: OpeningBalanceSource;

      if (dto.amount !== undefined) {
        openingBalance = dto.amount;
        openingBalanceSource = OpeningBalanceSource.MANUAL;
      } else {
        const previous = await this.findPreviousMonth(dto.year, dto.month, tx);
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
        await tx.pettyCashMonthlyLedger.update({
          where: { id: previous.id },
          data: { isClosed: true },
        });
      }

      return tx.pettyCashMonthlyLedger.create({
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
    });

    return this.toMonthlySummaryDto(created);
  }

  /**
   * Closes a month by hand.
   *
   * Carrying a balance forward closes the month it came from automatically,
   * which covers the ordinary path. This covers the other one: a month opened
   * with a manual figure leaves its predecessor open, and until now nothing
   * in the API could ever close it again — `isClosed` was written in exactly
   * one place, inside the carry-forward branch.
   *
   * Closing is a soft lock, not a freeze. It stops task settlements and
   * auto-filed scans from landing in the month; an admin can still add,
   * correct and adjust, because that is what month-end reconciliation is.
   */
  async closeMonth(
    year: number,
    month: number,
  ): Promise<MonthlySummaryResponseDto> {
    const ledger = await this.requireMonth(year, month);
    if (ledger.isClosed) {
      throw new ConflictException(
        `${formatMonth(year, month)} is already closed.`,
      );
    }

    await this.prisma.pettyCashMonthlyLedger.update({
      where: { id: ledger.id },
      data: { isClosed: true },
    });
    return this.getMonthlySummary(year, month);
  }

  /**
   * Reopens a closed month.
   *
   * The error raised when a task settles into a closed month tells the admin
   * to "reopen it or record this as a manual entry" — advice that was
   * impossible to follow, because no reopen existed. A late settlement is a
   * normal thing to happen, so the instruction is now actionable.
   */
  async reopenMonth(
    year: number,
    month: number,
  ): Promise<MonthlySummaryResponseDto> {
    const ledger = await this.requireMonth(year, month);
    if (!ledger.isClosed) {
      throw new ConflictException(`${formatMonth(year, month)} is already open.`);
    }

    await this.prisma.pettyCashMonthlyLedger.update({
      where: { id: ledger.id },
      data: { isClosed: false },
    });
    return this.getMonthlySummary(year, month);
  }

  async getMonthlySummary(
    year: number,
    month: number,
  ): Promise<MonthlySummaryResponseDto> {
    const ledger = await this.requireMonth(year, month);
    const [adjustments, entriesBySource] = await Promise.all([
      this.summariseAdjustments(ledger.id),
      this.countEntriesBySource(ledger.id),
    ]);
    return this.toMonthlySummaryDto(ledger, adjustments, entriesBySource);
  }

  private async findPreviousMonth(
    year: number,
    month: number,
    db: Db = this.prisma,
  ) {
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    return db.pettyCashMonthlyLedger.findUnique({
      where: { year_month: { year: prevYear, month: prevMonth } },
    });
  }

  private async requireMonth(
    year: number,
    month: number,
    db: Db = this.prisma,
  ) {
    const ledger = await db.pettyCashMonthlyLedger.findUnique({
      where: { year_month: { year, month } },
    });
    if (!ledger) {
      throw new NotFoundException(
        `No petty cash ledger open for ${formatMonth(year, month)}. An admin must open it first (carry-forward or manual opening balance).`,
      );
    }
    return ledger;
  }

  // --------------------------------------------------------------------
  //  Entries — listing
  // --------------------------------------------------------------------

  async listEntries(
    query: QueryLedgerDto,
  ): Promise<PaginatedLedgerResponseDto> {
    const year = query.year ?? new Date().getUTCFullYear();
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // The scope is the ledger the running balance is computed over: one month,
    // or the whole year. It is deliberately kept apart from the content filters
    // below — see `computeRunningBalances` for why mixing them is wrong.
    let scope: Prisma.PettyCashLedgerEntryWhereInput;

    if (query.month) {
      const ledger = await this.prisma.pettyCashMonthlyLedger.findUnique({
        where: { year_month: { year, month: query.month } },
      });
      // No ledger opened yet for that month = no entries, not an error;
      // the dashboard should render an empty state, not a 404.
      if (!ledger) {
        return { data: [], meta: buildPaginationMeta(page, limit, 0) };
      }
      scope = { monthlyLedgerId: ledger.id };
    } else {
      scope = { monthlyLedger: { year } };
    }

    const where: Prisma.PettyCashLedgerEntryWhereInput = { ...scope };

    if (query.source) where.source = query.source;
    if (query.category) where.category = query.category;
    if (query.staffId) where.staffId = query.staffId;
    if (query.needsReview !== undefined) where.needsReview = query.needsReview;
    if (query.dateFrom || query.dateTo) {
      where.entryDate = {
        ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
        ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
      };
    }
    if (query.search) {
      where.OR = [
        { description: { contains: escapeLike(query.search), mode: 'insensitive' } },
        { supplier: { contains: escapeLike(query.search), mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.pettyCashLedgerEntry.findMany({
        where,
        include: ENTRY_INCLUDE,
        orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.pettyCashLedgerEntry.count({ where }),
    ]);

    const runningBalances = await this.computeRunningBalances(scope);

    const data = rows.map(
      (row) =>
        new LedgerEntryResponseDto(
          this.mapEntry(row, runningBalances.get(row.id) ?? 0),
        ),
    );

    return { data, meta: buildPaginationMeta(page, limit, total) };
  }

  /**
   * Running balance after each entry, oldest-first, never persisted — see
   * "Balance calculation logic" in the module documentation.
   *
   * `scope` must describe the LEDGER (a month, or a year), never the caller's
   * content filters. A running balance is the ledger's own arithmetic: money in,
   * money out, in order. Computing it over a filtered subset — say, only the
   * FUEL rows — silently produces a column that looks like a balance but is the
   * running total of an arbitrary slice, and matches nothing the admin can
   * reconcile against.
   */
  private async computeRunningBalances(
    scope: Prisma.PettyCashLedgerEntryWhereInput,
    db: Db = this.prisma,
  ): Promise<Map<string, number>> {
    const all = await db.pettyCashLedgerEntry.findMany({
      where: scope,
      select: {
        id: true,
        amount: true,
        entryDate: true,
        createdAt: true,
        monthlyLedgerId: true,
      },
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
    });
    if (all.length === 0) return new Map();

    const ledgerIds = [...new Set(all.map((e) => e.monthlyLedgerId))];
    const ledgers = await db.pettyCashMonthlyLedger.findMany({
      where: { id: { in: ledgerIds } },
      select: {
        id: true,
        openingBalance: true,
        adjustments: { select: { type: true, amount: true } },
      },
    });

    // The walk starts from the month's *funded* position — opening plus the
    // net of its adjustments — not from the opening balance alone.
    //
    // Starting at the opening balance made the column fail to reconcile: the
    // newest row landed on `opening − expenses` while every other figure on
    // the screen (the Remaining balance card, the report's Closing balance)
    // showed `opening + top-ups − corrections − expenses`. A ledger whose own
    // balance column disagrees with its closing balance is worse than useless
    // to someone reconciling it.
    //
    // Adjustments are folded in up front rather than interleaved by date:
    // they carry a `createdAt` timestamp while entries carry an `entryDate`,
    // and ordering a date against a timestamp is arbitrary within a day. The
    // trade is that a mid-month top-up shows from the first row rather than
    // from the row it happened at — in exchange, the column always adds up.
    const startByLedger = new Map(
      ledgers.map((ledger) => {
        const net = ledger.adjustments.reduce(
          (sum, adjustment) =>
            adjustment.type === AdjustmentType.TOP_UP
              ? sum.plus(adjustment.amount)
              : sum.minus(adjustment.amount),
          new Prisma.Decimal(0),
        );
        return [ledger.id, Number(new Prisma.Decimal(ledger.openingBalance).plus(net))];
      }),
    );

    const running = new Map<string, number>();
    const runningTotals = new Map<string, number>();
    for (const entry of all) {
      const start = startByLedger.get(entry.monthlyLedgerId) ?? 0;
      const prevTotal = runningTotals.get(entry.monthlyLedgerId) ?? start;
      // Rounded every step: these are two-decimal money values, and letting
      // binary floating point accumulate across a few hundred rows produces
      // balances like 105356.99999999999.
      const next = Math.round((prevTotal - Number(entry.amount)) * 100) / 100;
      runningTotals.set(entry.monthlyLedgerId, next);
      running.set(entry.id, next);
    }
    return running;
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
    if (!receipt) {
      throw new NotFoundException('This entry has no receipt attached.');
    }

    const stream = await this.storage.createReadStream(receipt.storageKey);
    return {
      stream,
      mimeType: receipt.mimeType,
      originalName: receipt.originalName,
    };
  }

  private mapEntry(
    row: LedgerEntryRow,
    runningBalance: number,
  ): Partial<LedgerEntryResponseDto> {
    const receipt = row.receipt ?? row.task?.receipt;

    return {
      id: row.id,
      source: row.source,
      amount: Number(row.amount),
      category: row.category,
      description: row.description,
      supplier: row.supplier ?? undefined,
      entryDate: row.entryDate.toISOString().slice(0, 10),
      month: MONTH_NAMES[row.entryDate.getUTCMonth()] ?? '',
      paymentMethod: row.paymentMethod,
      staff: row.staff ? { id: row.staff.id, name: row.staff.name } : undefined,
      taskId: row.taskId ?? undefined,
      notes: row.notes ?? undefined,
      receipt: receipt
        ? {
            id: receipt.id,
            // The full path a client can GET. The global prefix and URI version
            // are part of the route, so a bare `/petty-cash/...` here would 404.
            url: `/api/v1/petty-cash/entries/${row.id}/receipt`,
            mimeType: receipt.mimeType,
          }
        : undefined,
      runningBalance,
      needsReview: row.needsReview,
      reviewNote: row.reviewNote ?? undefined,
      createdBy: { id: row.createdBy.id, name: row.createdBy.name },
      createdAt: row.createdAt.toISOString(),
    };
  }

  // --------------------------------------------------------------------
  //  Entries — manual creation (Admin)
  // --------------------------------------------------------------------

  async createManualEntry(
    dto: CreateManualEntryDto,
    adminId: string,
  ): Promise<LedgerEntryResponseDto> {
    const entryDate = new Date(dto.entryDate);

    return this.prisma.$transaction(async (tx) => {
      const ledger = await this.requireMonth(
        entryDate.getUTCFullYear(),
        entryDate.getUTCMonth() + 1,
        tx,
      );

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
        include: ENTRY_INCLUDE,
      });
      await this.recomputeLedgerTotals(ledger.id, tx);

      const balances = await this.computeRunningBalances(
        { monthlyLedgerId: ledger.id },
        tx,
      );
      return new LedgerEntryResponseDto(
        this.mapEntry(entry, balances.get(entry.id) ?? 0),
      );
    });
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
   *
   * Pass `tx` to join the caller's transaction. The Task module does exactly
   * that, because marking a task submitted and booking its expense have to
   * be one atomic step: `submittedAt` is a one-way door, so a task that
   * submits successfully while this write fails can never be settled again.
   */
  async createFromTask(
    params: TaskEntryParams,
    tx?: Prisma.TransactionClient,
  ): Promise<LedgerEntryResponseDto> {
    if (tx) return this.writeTaskEntry(params, tx);
    return this.prisma.$transaction((inner) =>
      this.writeTaskEntry(params, inner),
    );
  }

  private async writeTaskEntry(
    params: TaskEntryParams,
    db: Db,
  ): Promise<LedgerEntryResponseDto> {
    const existing = await db.pettyCashLedgerEntry.findUnique({
      where: { taskId: params.taskId },
    });
    if (existing) {
      throw new ConflictException(
        `Task ${params.taskId} has already been settled into the petty cash ledger.`,
      );
    }

    const ledger = await this.requireMonth(
      params.entryDate.getUTCFullYear(),
      params.entryDate.getUTCMonth() + 1,
      db,
    );
    if (ledger.isClosed) {
      throw new BadRequestException(
        `Petty cash ledger for ${formatMonth(ledger.year, ledger.month)} is closed. An admin must reopen it or record this as a manual entry with an adjustment.`,
      );
    }

    const review = this.taskEntryReviewNote(params);

    const entry = await db.pettyCashLedgerEntry.create({
      data: {
        monthlyLedgerId: ledger.id,
        source: LedgerEntrySource.TASK,
        // The receipt's own category when it was read, otherwise the old
        // fallback. An admin recategorises from the ledger table if needed.
        category: params.scanned?.category ?? 'MISCELLANEOUS',
        amount: params.amountSpent,
        // Prefer what the receipt says was bought over the errand's title —
        // "Diesel, 32 litres" reconciles; "Deliver documents" does not.
        description: params.scanned?.description ?? params.description,
        supplier: params.scanned?.vendor ?? params.vendorDetails,
        entryDate: params.entryDate,
        paymentMethod: 'PETTY_CASH',
        staffId: params.officeBoyId,
        taskId: params.taskId,
        createdById: params.officeBoyId,
        needsReview: review !== null,
        reviewNote: review,
      },
      include: ENTRY_INCLUDE,
    });
    await this.recomputeLedgerTotals(ledger.id, db);

    const balances = await this.computeRunningBalances(
      { monthlyLedgerId: ledger.id },
      db,
    );
    return new LedgerEntryResponseDto(
      this.mapEntry(entry, balances.get(entry.id) ?? 0),
    );
  }

  /**
   * What an admin should check about an office-boy entry, or null if nothing.
   *
   * This is the whole safeguard on the office-boy path. Nobody reviews the
   * expense before it is filed — the office boy uploads a photo, submits, and
   * money lands in the ledger — so anything the machine was unsure about has
   * to be surfaced afterwards instead.
   *
   * The entry is always created. An expense that happened is a fact; refusing
   * to record it would make it invisible, which is strictly worse than
   * recording it with a flag. The flag is the control, not the refusal.
   */
  private taskEntryReviewNote(params: TaskEntryParams): string | null {
    const { scanned, typedNetAmount, amountSpent } = params;

    if (!scanned) {
      // Filed purely on a number the office boy typed, with no receipt to
      // check it against. That is the weakest evidence the ledger accepts.
      return 'No receipt was attached — this amount is unverified.';
    }

    // The reader itself failed — an outage, a rate limit, no API key. Say so,
    // rather than reporting an unreadable receipt: this is not the office boy's
    // photo being bad, and sending an admin to squint at a perfectly good
    // receipt wastes the one thing the flag is meant to save.
    if (scanned.failureReason) {
      return `${scanned.failureReason} The office boy's figure of ${typedNetAmount} was used — check it against the receipt.`;
    }

    if (scanned.amount === undefined) {
      return `The receipt was uploaded but no total could be read, so the office boy's figure of ${typedNetAmount} was used.`;
    }

    // Both numbers exist and disagree. This is the check worth having: the
    // receipt says one thing, the cash he handed back says another.
    const difference =
      Math.round(Math.abs(scanned.amount - typedNetAmount) * 100) / 100;
    if (typedNetAmount > 0 && difference > AMOUNT_TOLERANCE) {
      return `The receipt shows ${scanned.amount} but the office boy recorded ${typedNetAmount} — a difference of ${difference}.`;
    }

    if (typedNetAmount === 0) {
      return `Filed from the receipt (${scanned.amount}); the office boy recorded no amounts.`;
    }

    const threshold = this.config.receiptAutoCreateConfidence;
    if (scanned.confidence < threshold) {
      return `The receipt was read with low confidence (${scanned.confidence.toFixed(2)}, below ${threshold.toFixed(2)}). Amount filed: ${amountSpent}.`;
    }

    return null;
  }

  /**
   * Marks an entry as reviewed.
   *
   * Deliberately not a general "status" field with its own state machine — an
   * entry either needs an admin's eyes or it does not, and saying so is one
   * boolean. Editing the entry counts as review too; this route exists for the
   * case where the admin looked and found nothing to change.
   */
  async approveEntry(id: string): Promise<LedgerEntryResponseDto> {
    const existing = await this.prisma.pettyCashLedgerEntry.findUnique({
      where: { id },
      select: { id: true, monthlyLedgerId: true },
    });
    if (!existing) throw new NotFoundException(`Ledger entry ${id} not found.`);

    const entry = await this.prisma.pettyCashLedgerEntry.update({
      where: { id },
      data: { needsReview: false, reviewNote: null },
      include: ENTRY_INCLUDE,
    });

    const balances = await this.computeRunningBalances({
      monthlyLedgerId: existing.monthlyLedgerId,
    });
    return new LedgerEntryResponseDto(
      this.mapEntry(entry, balances.get(entry.id) ?? 0),
    );
  }

  // --------------------------------------------------------------------
  //  Entries — scan receipt flow
  // --------------------------------------------------------------------

  /**
   * Step 1 of the Scan Receipt panel: store the file, read it, and either file
   * the expense outright or hand the values back for review.
   *
   * The split is the confidence threshold. Above it, with every required field
   * legible and the month open, the entry is created here and the admin is done.
   * Below it — or with anything missing — the scan is parked and the client
   * shows the values for confirmation. The deciding logic is in `reviewReason`:
   * every path that declines to auto-create says why, because "it didn't work"
   * is not something an admin can act on.
   */
  async extractFromReceipt(
    adminId: string,
    file?: Express.Multer.File,
  ): Promise<ScanExtractionResponseDto> {
    await this.sweepExpiredScans();

    if (!file) {
      throw new BadRequestException('A receipt file is required.');
    }
    // multer's own `limits.fileSize` already aborts an oversized upload
    // mid-stream; this re-check enforces a deployment that configured a
    // *lower* ceiling than the decorator's compile-time literal.
    if (file.size > this.config.maxReceiptBytes) {
      throw new BadRequestException(
        `Receipt exceeds the ${Math.floor(this.config.maxReceiptBytes / (1024 * 1024))}MB limit.`,
      );
    }

    // Sniff the real bytes rather than trusting the declared Content-Type: the
    // client controls that header, and a mislabelled upload is the cheapest way
    // to get an unexpected file type into storage.
    const mimeType = sniffMimeType(file.buffer);
    if (!mimeType) {
      throw new BadRequestException(
        `Unsupported file type. Accepted: ${ALLOWED_RECEIPT_MIME_TYPES.join(', ')}.`,
      );
    }

    const contentHash = this.duplicates.hash(file.buffer);

    const stored = await this.storage.save(file.buffer, {
      mimeType,
      originalName: file.originalname,
      namespace: 'petty-cash-receipts',
    });

    // Never throws: an outage or a refusal comes back as confidence 0 with a
    // reason, which routes the receipt to manual review rather than failing the
    // upload the admin already waited for.
    const extraction = await this.extractor.extract(file.buffer, mimeType);

    const extracted: ExtractedReceiptFieldsDto = {
      amount: extraction.amount,
      vendor: extraction.vendor,
      date: extraction.date,
      category: extraction.category,
      description: extraction.description,
    };

    // A duplicate never files itself, however confident the extraction was.
    // Paying the same receipt twice is the failure this whole check exists to
    // prevent, so it outranks the confidence score.
    const duplicate = await this.duplicates.find(contentHash, extraction);
    const blocker = duplicate
      ? duplicate.reason
      : await this.autoCreateBlocker(extraction);

    if (!blocker) {
      const entry = await this.createFromExtraction(
        extraction,
        { ...stored, originalName: file.originalname, contentHash },
        adminId,
      );
      return new ScanExtractionResponseDto({
        status: 'AUTO_CREATED',
        confidence: extraction.confidence,
        extracted,
        entry,
      });
    }

    const uploadToken = `upl_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await this.prisma.pendingReceiptScan.create({
      data: {
        uploadToken,
        storageKey: stored.key,
        originalName: file.originalname,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        contentHash,
        extractedAmount: extraction.amount,
        extractedVendor: extraction.vendor,
        extractedDate: extraction.date ? new Date(extraction.date) : undefined,
        extractedDescription: extraction.description,
        suggestedCategory: extraction.category,
        confidence: extraction.confidence,
        failureReason: extraction.failureReason,
        uploadedById: adminId,
        expiresAt: new Date(Date.now() + SCAN_TTL_MS),
      },
    });

    return new ScanExtractionResponseDto({
      status: 'NEEDS_REVIEW',
      confidence: extraction.confidence,
      extracted,
      uploadToken,
      reviewReason: blocker,
      duplicate: duplicate ?? undefined,
    });
  }

  /**
   * Why this receipt must not be filed automatically, or null when it may be.
   *
   * Deliberately conservative, and each check exists for its own reason. The
   * threshold is the headline one, but a confident extraction missing the date
   * still cannot be filed — the date decides which month's ledger it lands in,
   * and guessing that would put real money in the wrong month. Likewise an
   * absent category: defaulting to MISCELLANEOUS would file a silently
   * miscategorised expense, which is harder to notice than an unfiled one.
   */
  private async autoCreateBlocker(
    extraction: ReceiptExtraction,
  ): Promise<string | null> {
    if (extraction.failureReason) return extraction.failureReason;

    const threshold = this.config.receiptAutoCreateConfidence;
    if (extraction.confidence < threshold) {
      return `Confidence ${extraction.confidence.toFixed(2)} is below the ${threshold.toFixed(2)} auto-create threshold.`;
    }
    if (extraction.amount === undefined) return 'Could not read the amount.';
    if (extraction.date === undefined) return 'Could not read the date.';
    if (extraction.category === undefined) {
      return 'Could not determine the expense category.';
    }

    // The month has to be open before we can file into it. Checked here rather
    // than letting the write fail, so the admin gets "open the month" instead
    // of a stack of nulls.
    const entryDate = new Date(`${extraction.date}T00:00:00.000Z`);
    const ledger = await this.prisma.pettyCashMonthlyLedger.findUnique({
      where: {
        year_month: {
          year: entryDate.getUTCFullYear(),
          month: entryDate.getUTCMonth() + 1,
        },
      },
    });
    if (!ledger) {
      return `No petty cash ledger is open for ${formatMonth(entryDate.getUTCFullYear(), entryDate.getUTCMonth() + 1)}.`;
    }
    if (ledger.isClosed) {
      return `The ledger for ${formatMonth(ledger.year, ledger.month)} is closed.`;
    }

    return null;
  }

  /** Files a high-confidence scan straight into the ledger, receipt attached. */
  private async createFromExtraction(
    extraction: ReceiptExtraction,
    stored: {
      key: string;
      mimeType: string;
      sizeBytes: number;
      originalName: string;
      contentHash: string;
    },
    adminId: string,
  ): Promise<LedgerEntryResponseDto> {
    const entryDate = new Date(`${extraction.date!}T00:00:00.000Z`);

    return this.prisma.$transaction(async (tx) => {
      const ledger = await this.requireMonth(
        entryDate.getUTCFullYear(),
        entryDate.getUTCMonth() + 1,
        tx,
      );

      const entry = await tx.pettyCashLedgerEntry.create({
        data: {
          monthlyLedgerId: ledger.id,
          source: LedgerEntrySource.MANUAL,
          amount: extraction.amount!,
          category: extraction.category!,
          description:
            extraction.description ?? extraction.vendor ?? 'Scanned receipt',
          supplier: extraction.vendor,
          entryDate,
          paymentMethod: 'PETTY_CASH',
          createdById: adminId,
          // Recorded so an admin reviewing this entry later can tell it was
          // filed by the scanner and how sure it was.
          notes: `Auto-filed from a scanned receipt (confidence ${extraction.confidence.toFixed(2)}).`,
          receipt: {
            create: {
              storageKey: stored.key,
              originalName: stored.originalName,
              mimeType: stored.mimeType,
              sizeBytes: stored.sizeBytes,
              contentHash: stored.contentHash,
              extractedAmount: extraction.amount,
              extractedVendor: extraction.vendor,
              extractedDate: entryDate,
            },
          },
        },
        include: ENTRY_INCLUDE,
      });
      await this.recomputeLedgerTotals(ledger.id, tx);

      const balances = await this.computeRunningBalances(
        { monthlyLedgerId: ledger.id },
        tx,
      );
      return new LedgerEntryResponseDto(
        this.mapEntry(entry, balances.get(entry.id) ?? 0),
      );
    });
  }

  /**
   * Drops scans whose confirmation window has closed, and deletes the file each
   * one parked in storage.
   *
   * Without this, every abandoned scan leaks twice: the row stays in the table
   * and the uploaded receipt sits in storage with nothing referencing it. Swept
   * lazily on the two routes that touch pending scans rather than on a timer,
   * which keeps this module free of a scheduler dependency.
   */
  private async sweepExpiredScans(): Promise<void> {
    const expired = await this.prisma.pendingReceiptScan.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true, storageKey: true },
    });
    if (expired.length === 0) return;

    await this.prisma.pendingReceiptScan.deleteMany({
      where: { id: { in: expired.map((scan) => scan.id) } },
    });

    for (const scan of expired) {
      try {
        await this.storage.delete(scan.storageKey);
      } catch (error) {
        // A failed cleanup must not fail the caller's request — the orphan is
        // a housekeeping problem, not a correctness one.
        this.logger.warn(
          `Could not delete expired scan ${scan.storageKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  async confirmScanEntry(
    uploadToken: string,
    dto: ConfirmScanEntryDto,
    adminId: string,
  ): Promise<LedgerEntryResponseDto> {
    await this.sweepExpiredScans();

    const pending = await this.prisma.pendingReceiptScan.findUnique({
      where: { uploadToken },
    });
    if (!pending) {
      throw new NotFoundException(
        'Upload token not found or expired. Re-upload the receipt.',
      );
    }

    const entryDate = new Date(dto.entryDate);

    return this.prisma.$transaction(async (tx) => {
      const ledger = await this.requireMonth(
        entryDate.getUTCFullYear(),
        entryDate.getUTCMonth() + 1,
        tx,
      );

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
              contentHash: pending.contentHash,
              // The raw extraction, kept for audit next to what the admin
              // actually confirmed on the entry itself.
              extractedAmount: pending.extractedAmount,
              extractedVendor: pending.extractedVendor,
              extractedDate: pending.extractedDate,
            },
          },
        },
        include: ENTRY_INCLUDE,
      });
      await this.recomputeLedgerTotals(ledger.id, tx);

      // Consume the token inside the transaction. If the entry write fails —
      // most likely because no ledger is open for that month — the delete rolls
      // back with it, so the admin can open the month and confirm the same
      // upload rather than re-scanning the receipt.
      await tx.pendingReceiptScan.delete({ where: { id: pending.id } });

      const balances = await this.computeRunningBalances(
        { monthlyLedgerId: ledger.id },
        tx,
      );
      return new LedgerEntryResponseDto(
        this.mapEntry(entry, balances.get(entry.id) ?? 0),
      );
    });
  }

  // --------------------------------------------------------------------
  //  Entries — update / delete (Admin)
  // --------------------------------------------------------------------

  async updateEntry(
    id: string,
    dto: UpdateEntryDto,
  ): Promise<LedgerEntryResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.pettyCashLedgerEntry.findUnique({
        where: { id },
      });
      if (!existing)
        throw new NotFoundException(`Ledger entry ${id} not found.`);

      const entryDate = dto.entryDate
        ? new Date(dto.entryDate)
        : existing.entryDate;
      const targetLedger = await this.requireMonth(
        entryDate.getUTCFullYear(),
        entryDate.getUTCMonth() + 1,
        tx,
      );

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
          // An admin editing a flagged entry has, by definition, reviewed it.
          // Leaving the flag set would keep it in the queue forever and train
          // people to ignore the queue.
          needsReview: false,
          reviewNote: null,
        },
        include: ENTRY_INCLUDE,
      });

      // Moving an entry across months changes the totals of BOTH ledgers.
      for (const ledgerId of new Set([
        existing.monthlyLedgerId,
        targetLedger.id,
      ])) {
        await this.recomputeLedgerTotals(ledgerId, tx);
      }

      const balances = await this.computeRunningBalances(
        { monthlyLedgerId: targetLedger.id },
        tx,
      );
      return new LedgerEntryResponseDto(
        this.mapEntry(entry, balances.get(entry.id) ?? 0),
      );
    });
  }

  async deleteEntry(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.pettyCashLedgerEntry.findUnique({
        where: { id },
      });
      if (!existing)
        throw new NotFoundException(`Ledger entry ${id} not found.`);

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
    await this.prisma.$transaction(async (tx) => {
      const ledger = await this.requireMonth(year, month, tx);

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
  private async recomputeLedgerTotals(monthlyLedgerId: string, tx: Db) {
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

  /**
   * Top-ups and corrections, reported separately and in detail.
   *
   * The ledger caches only the *net* of the two, inside `remainingBalance`,
   * which is enough to reconcile a month but not enough to report one:
   * +10,000 of top-ups against −2,000 of corrections is indistinguishable
   * from a single +8,000 top-up.
   *
   * Read as rows rather than aggregated in SQL because the dashboard wants
   * the count and the latest date as well as the sum, and a month holds a
   * handful of adjustments at most — the covering index on
   * (monthlyLedgerId, createdAt) makes this one cheap seek.
   */
  private async summariseAdjustments(monthlyLedgerId: string): Promise<{
    topUps: number;
    corrections: number;
    topUpCount: number;
    correctionCount: number;
    lastTopUpAt?: string;
  }> {
    const rows = await this.prisma.pettyCashBalanceAdjustment.findMany({
      where: { monthlyLedgerId },
      select: { type: true, amount: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const of = (type: AdjustmentType) => rows.filter((row) => row.type === type);
    const sum = (list: typeof rows) =>
      Number(
        list.reduce(
          (total, row) => total.plus(row.amount),
          new Prisma.Decimal(0),
        ),
      );

    const topUps = of(AdjustmentType.TOP_UP);
    const corrections = of(AdjustmentType.CORRECTION);

    return {
      topUps: sum(topUps),
      corrections: sum(corrections),
      topUpCount: topUps.length,
      correctionCount: corrections.length,
      // Newest first, so the head of the list is the most recent top-up.
      lastTopUpAt: topUps[0]?.createdAt.toISOString(),
    };
  }

  /**
   * How many of the month's entries came from a task versus an admin.
   *
   * Also supplies `totalEntries` — the two counts always sum to it, so
   * counting separately would be a second query that could disagree.
   */
  private async countEntriesBySource(
    monthlyLedgerId: string,
  ): Promise<{ task: number; manual: number }> {
    const grouped = await this.prisma.pettyCashLedgerEntry.groupBy({
      by: ['source'],
      where: { monthlyLedgerId },
      _count: { _all: true },
    });

    // Prisma widens `_count` to a union here; for `_count: { _all: true }`
    // the runtime shape is always `{ _all: number }`.
    const rows = grouped as unknown as {
      source: LedgerEntrySource;
      _count: { _all: number };
    }[];
    const countOf = (source: LedgerEntrySource) =>
      rows.find((row) => row.source === source)?._count._all ?? 0;

    return {
      task: countOf(LedgerEntrySource.TASK),
      manual: countOf(LedgerEntrySource.MANUAL),
    };
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
      createdAt: Date;
    },
    // A month that has just been opened has neither adjustments nor entries,
    // which is exactly what these defaults describe.
    adjustments: {
      topUps: number;
      corrections: number;
      topUpCount: number;
      correctionCount: number;
      lastTopUpAt?: string;
    } = { topUps: 0, corrections: 0, topUpCount: 0, correctionCount: 0 },
    entriesBySource: { task: number; manual: number } = { task: 0, manual: 0 },
  ): MonthlySummaryResponseDto {
    return new MonthlySummaryResponseDto({
      id: ledger.id,
      year: ledger.year,
      month: ledger.month,
      openingBalance: Number(ledger.openingBalance),
      openingBalanceSource: ledger.openingBalanceSource as OpeningBalanceSource,
      openedAt: ledger.createdAt.toISOString(),
      totalExpenses: Number(ledger.totalExpenses),
      totalTopUps: adjustments.topUps,
      totalCorrections: adjustments.corrections,
      topUpCount: adjustments.topUpCount,
      correctionCount: adjustments.correctionCount,
      lastTopUpAt: adjustments.lastTopUpAt,
      remainingBalance: Number(ledger.remainingBalance),
      totalEntries: entriesBySource.task + entriesBySource.manual,
      entriesBySource,
      isClosed: ledger.isClosed,
      note: ledger.note ?? undefined,
    });
  }
}

/** `2026-08`, for the error messages an admin has to act on. */
function formatMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}
