import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { contentHash } from '../storage/content-hash';
import type { ReceiptExtraction } from './receipt-extraction.service';

/** How a receipt was recognised as one already on file. */
export type DuplicateMatchType =
  /** Byte-for-byte the same file — the same photo uploaded twice. */
  | 'IDENTICAL_FILE'
  /** A different photo of a receipt already filed with the same details. */
  | 'SAME_VENDOR_AMOUNT_DATE'
  /** The same file is already uploaded and waiting for someone to confirm it. */
  | 'PENDING_SCAN';

export interface DuplicateMatch {
  matchType: DuplicateMatchType;
  /** The entry this receipt appears to repeat. Absent for a PENDING_SCAN. */
  entryId?: string;
  entryDate?: string;
  amount?: number;
  supplier?: string;
  /** A sentence naming what was matched, for the admin to act on. */
  reason: string;
}

/**
 * Recognises a receipt that has already been filed.
 *
 * Submitting the same receipt twice is the most common way petty cash leaks —
 * usually by accident (a retried upload, a receipt photographed from two
 * angles), occasionally not. Both cases are cheap to catch and expensive to
 * find later in a reconciliation.
 *
 * Deliberately NOT an AI feature. Two exact database lookups answer this
 * better than any model could, at no cost per receipt and with no chance of a
 * confident wrong answer.
 *
 * A match never blocks anything on its own — it routes the receipt to a human
 * with the reason attached. Re-filing a receipt is sometimes legitimate (an
 * entry was deleted and is being re-added), and only the admin knows which
 * case they are in.
 */
@Injectable()
export class ReceiptDuplicateService {
  constructor(private readonly prisma: PrismaService) {}

  /** SHA-256 of the file's bytes, hex encoded. */
  hash(buffer: Buffer): string {
    return contentHash(buffer);
  }

  /**
   * Looks for a receipt already on file, exact match first.
   *
   * Order matters: an identical file is certain, whereas matching vendor,
   * amount and date is strong evidence but not proof — a courier used twice in
   * one day for the same fee is a real thing. Reporting the certain match when
   * both are present gives the admin the more useful message.
   */
  async find(
    contentHash: string,
    extraction: ReceiptExtraction,
  ): Promise<DuplicateMatch | null> {
    return (
      (await this.byIdenticalFile(contentHash)) ??
      (await this.byPendingScan(contentHash)) ??
      (await this.byDetails(extraction))
    );
  }

  /**
   * The same bytes, already attached to a filed entry.
   *
   * Checks both receipt tables: a receipt can reach the ledger through the
   * admin's scan panel (PettyCashReceipt) or through an office boy's task
   * (TaskReceipt), and the same photo sent down both routes is still a
   * duplicate.
   */
  private async byIdenticalFile(
    contentHash: string,
  ): Promise<DuplicateMatch | null> {
    const onEntry = await this.prisma.pettyCashReceipt.findFirst({
      where: { contentHash },
      select: { ledgerEntry: { select: SUMMARY_SELECT } },
    });
    if (onEntry) {
      return this.identical(onEntry.ledgerEntry);
    }

    const onTask = await this.prisma.taskReceipt.findFirst({
      where: { contentHash },
      select: { taskId: true },
    });
    if (!onTask) return null;

    // The task's receipt is on file. It only counts as a ledger duplicate if
    // that task actually reached the ledger — an unsubmitted task has taken no
    // money out of petty cash yet.
    const entry = await this.prisma.pettyCashLedgerEntry.findUnique({
      where: { taskId: onTask.taskId },
      select: SUMMARY_SELECT,
    });
    return entry ? this.identical(entry) : null;
  }

  /** The same bytes, uploaded already and still awaiting confirmation. */
  private async byPendingScan(
    contentHash: string,
  ): Promise<DuplicateMatch | null> {
    const pending = await this.prisma.pendingReceiptScan.findFirst({
      where: { contentHash, expiresAt: { gt: new Date() } },
      select: { createdAt: true },
    });
    if (!pending) return null;

    return {
      matchType: 'PENDING_SCAN',
      reason:
        'This exact receipt was already uploaded and is waiting to be confirmed.',
    };
  }

  /**
   * A different photo of a receipt that is already filed.
   *
   * Needs all three of vendor, amount and date — any fewer and the match is too
   * loose to be worth raising. Two office supply runs to the same shop on the
   * same day for different amounts should not flag each other.
   */
  private async byDetails(
    extraction: ReceiptExtraction,
  ): Promise<DuplicateMatch | null> {
    const { vendor, amount, date } = extraction;
    if (!vendor || amount === undefined || !date) return null;

    const entryDate = new Date(`${date}T00:00:00.000Z`);
    const entry = await this.prisma.pettyCashLedgerEntry.findFirst({
      where: {
        supplier: { equals: vendor, mode: 'insensitive' },
        amount,
        entryDate,
      },
      select: SUMMARY_SELECT,
    });
    if (!entry) return null;

    return {
      matchType: 'SAME_VENDOR_AMOUNT_DATE',
      ...summarise(entry),
      reason: `An entry for ${vendor} of ${Number(entry.amount)} on ${date} already exists.`,
    };
  }

  private identical(entry: EntrySummary): DuplicateMatch {
    return {
      matchType: 'IDENTICAL_FILE',
      ...summarise(entry),
      reason: `This exact receipt file is already attached to an entry dated ${entry.entryDate.toISOString().slice(0, 10)}.`,
    };
  }
}

const SUMMARY_SELECT = {
  id: true,
  entryDate: true,
  amount: true,
  supplier: true,
} as const;

interface EntrySummary {
  id: string;
  entryDate: Date;
  amount: unknown;
  supplier: string | null;
}

function summarise(entry: EntrySummary) {
  return {
    entryId: entry.id,
    entryDate: entry.entryDate.toISOString().slice(0, 10),
    amount: Number(entry.amount),
    supplier: entry.supplier ?? undefined,
  };
}
