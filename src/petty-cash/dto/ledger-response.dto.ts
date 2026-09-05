import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PaginationMetaDto } from '../../common/dto/api-response.dto';
import {
  LedgerEntrySource,
  OpeningBalanceSource,
  PaymentMethod,
  PettyCashCategory,
} from '../../generated/prisma/enums';

class StaffSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ahmed Raza' })
  name!: string;
}

class ReceiptSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    description:
      'API path to download/stream the receipt file (GET /petty-cash/entries/:id/receipt).',
  })
  url!: string;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType!: string;
}

export class LedgerEntryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: LedgerEntrySource })
  source!: LedgerEntrySource;

  @ApiProperty({ example: 2145.5 })
  amount!: number;

  @ApiProperty({ enum: PettyCashCategory })
  category!: PettyCashCategory;

  @ApiProperty({ example: 'Printer ink cartridges and A4 paper restock' })
  description!: string;

  @ApiPropertyOptional({ example: 'Shell Petrol Station' })
  supplier?: string;

  @ApiProperty({ example: '2026-10-24' })
  entryDate!: string;

  @ApiProperty({
    description: 'Calendar month label, derived from entryDate.',
    example: 'October',
  })
  month!: string;

  @ApiProperty({ enum: PaymentMethod })
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({ type: StaffSummaryDto })
  staff?: StaffSummaryDto;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Present only for TASK-sourced entries.',
  })
  taskId?: string;

  @ApiPropertyOptional()
  notes?: string;

  @ApiPropertyOptional({ type: ReceiptSummaryDto })
  receipt?: ReceiptSummaryDto;

  @ApiProperty({
    description:
      'Running balance immediately after this entry, computed at read time in the current sort order. Not persisted — see module documentation, "Balance calculation logic".',
    example: 2854.5,
  })
  runningBalance!: number;

  @ApiProperty({
    description:
      "True when this entry was filed automatically and something about it needs checking — an unread receipt total, a figure that disagrees with the office boy's, or a low-confidence read. Clear it with POST /petty-cash/entries/:id/approve.",
    example: false,
  })
  needsReview!: boolean;

  @ApiPropertyOptional({
    description: 'What to check. Present only when needsReview is true.',
    example:
      'The receipt shows 2145.5 but the office boy recorded 2000 — a difference of 145.5.',
  })
  reviewNote?: string;

  @ApiProperty({ type: StaffSummaryDto, description: 'Who created this row.' })
  createdBy!: StaffSummaryDto;

  @ApiProperty()
  createdAt!: string;

  constructor(partial: Partial<LedgerEntryResponseDto>) {
    Object.assign(this, partial);
  }
}

/**
 * The same `{ data, meta }` envelope every other list endpoint returns, built
 * by the shared `buildPaginationMeta` helper. Petty cash previously returned a
 * flat `{ data, page, pageSize, totalCount }`, which meant a client needed a
 * second unwrapper for this one module.
 */
export class PaginatedLedgerResponseDto {
  @ApiProperty({ type: [LedgerEntryResponseDto] })
  data!: LedgerEntryResponseDto[];

  @ApiProperty({
    type: PaginationMetaDto,
    description: 'Totals cover the whole filtered set, not just this page.',
  })
  meta!: PaginationMetaDto;
}

/**
 * How a month's entries divide between the two ways one can arrive.
 *
 * The dashboard reports the split under the entry count, because "84 entries"
 * says nothing about whether the office boys or the admin did the work.
 */
export class EntrySourceCountsDto {
  @ApiProperty({
    example: 61,
    description: 'Entries created by settling an office boy task.',
  })
  task!: number;

  @ApiProperty({
    example: 23,
    description:
      'Entries an admin recorded by hand, including those filed from a receipt scan.',
  })
  manual!: number;
}

export class MonthlySummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 2026 })
  year!: number;

  @ApiProperty({ example: 10 })
  month!: number;

  @ApiProperty({
    example: 5000.0,
    description: 'Shown on the dashboard as "Monthly Allocation".',
  })
  openingBalance!: number;

  @ApiProperty({ enum: OpeningBalanceSource })
  openingBalanceSource!: OpeningBalanceSource;

  @ApiProperty({
    example: '2026-08-01T04:12:55.000Z',
    description:
      'When this month was opened. The dashboard reports it as "Opened 1 Aug" — the day the float was actually set, which is not always the first of the month.',
  })
  openedAt!: string;

  @ApiProperty({ example: 2145.5 })
  totalExpenses!: number;

  @ApiProperty({
    example: 10000,
    description:
      'Sum of the TOP_UP adjustments recorded against this month. Reported separately from corrections because neither can be recovered from `remainingBalance` alone — a +10,000 top-up with a −2,000 correction nets to exactly the same figure as a single +8,000 top-up.',
  })
  totalTopUps!: number;

  @ApiProperty({
    example: 500,
    description:
      'Sum of the CORRECTION adjustments recorded against this month, always reported positive. Corrections subtract from the balance.',
  })
  totalCorrections!: number;

  @ApiProperty({ example: 2854.5 })
  remainingBalance!: number;

  @ApiProperty({
    example: 3,
    description:
      'Count of ledger entries in this month (calculated, not stored).',
  })
  totalEntries!: number;

  @ApiProperty({
    type: EntrySourceCountsDto,
    description: 'The same total, split by how each entry arrived.',
  })
  entriesBySource!: EntrySourceCountsDto;

  @ApiProperty({
    example: 1,
    description:
      'How many adjustments make up `totalTopUps`. The dashboard needs the count to choose between naming a single top-up and summarising several.',
  })
  topUpCount!: number;

  @ApiProperty({
    example: 0,
    description: 'How many adjustments make up `totalCorrections`.',
  })
  correctionCount!: number;

  @ApiPropertyOptional({
    example: '2026-08-12T09:30:00.000Z',
    description:
      'When the most recent top-up was recorded. Absent when the month has none.',
  })
  lastTopUpAt?: string;

  @ApiProperty()
  isClosed!: boolean;

  @ApiPropertyOptional()
  note?: string;

  constructor(partial: Partial<MonthlySummaryResponseDto>) {
    Object.assign(this, partial);
  }
}
