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

  @ApiProperty({ example: 2145.5 })
  totalExpenses!: number;

  @ApiProperty({ example: 2854.5 })
  remainingBalance!: number;

  @ApiProperty({
    example: 3,
    description:
      'Count of ledger entries in this month (calculated, not stored).',
  })
  totalEntries!: number;

  @ApiProperty()
  isClosed!: boolean;

  @ApiPropertyOptional()
  note?: string;

  constructor(partial: Partial<MonthlySummaryResponseDto>) {
    Object.assign(this, partial);
  }
}
