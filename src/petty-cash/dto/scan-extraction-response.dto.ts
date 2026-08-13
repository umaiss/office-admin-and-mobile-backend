import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { PettyCashCategory } from '../../generated/prisma/enums';
import type { DuplicateMatchType } from '../receipt-duplicate.service';
import { LedgerEntryResponseDto } from './ledger-response.dto';

/** A receipt already on file that this upload appears to repeat. */
export class DuplicateMatchDto {
  @ApiProperty({
    enum: ['IDENTICAL_FILE', 'SAME_VENDOR_AMOUNT_DATE', 'PENDING_SCAN'],
    description:
      'IDENTICAL_FILE is byte-for-byte the same photo. SAME_VENDOR_AMOUNT_DATE is a different photo of an already-filed expense. PENDING_SCAN means the same file is already uploaded and awaiting confirmation.',
  })
  matchType!: DuplicateMatchType;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The existing entry. Absent for PENDING_SCAN, which has not become an entry yet.',
  })
  entryId?: string;

  @ApiPropertyOptional({ example: '2026-08-05' })
  entryDate?: string;

  @ApiPropertyOptional({ example: 2145.5 })
  amount?: number;

  @ApiPropertyOptional({ example: 'Shell Petrol Station' })
  supplier?: string;

  @ApiProperty({
    example:
      'This exact receipt file is already attached to an entry dated 2026-08-05.',
    description: 'Show this to the admin — it names what was matched.',
  })
  reason!: string;
}

/**
 * What a scanned receipt became.
 *
 * `AUTO_CREATED` — the extraction cleared the confidence threshold and every
 * field needed to file the expense was legible, so the ledger entry already
 * exists. Correct it with `PATCH /petty-cash/entries/:id` if anything is off.
 *
 * `NEEDS_REVIEW` — the receipt is stored and the values below are suggestions.
 * Show them for the admin to confirm or correct, then post them back to
 * `POST /petty-cash/entries/scan/confirm` with the `uploadToken`.
 */
export type ScanStatus = 'AUTO_CREATED' | 'NEEDS_REVIEW';

/** The fields read off the receipt. Any of them may be absent. */
export class ExtractedReceiptFieldsDto {
  @ApiPropertyOptional({ example: 2145.5 })
  amount?: number;

  @ApiPropertyOptional({ example: 'Shell Petrol Station' })
  vendor?: string;

  @ApiPropertyOptional({ example: '2026-08-05', description: 'YYYY-MM-DD.' })
  date?: string;

  @ApiPropertyOptional({ enum: PettyCashCategory })
  category?: PettyCashCategory;

  @ApiPropertyOptional({
    example: 'Diesel, 32 litres',
    description: 'What was purchased, from the receipt line items.',
  })
  description?: string;
}

export class ScanExtractionResponseDto {
  @ApiProperty({
    enum: ['AUTO_CREATED', 'NEEDS_REVIEW'],
    description:
      'AUTO_CREATED means `entry` is already in the ledger. NEEDS_REVIEW means use `uploadToken` to confirm.',
  })
  status!: ScanStatus;

  @ApiProperty({
    example: 0.91,
    description:
      'Extraction confidence, 0-1. Compared against RECEIPT_AUTOCREATE_CONFIDENCE to decide the status above.',
  })
  confidence!: number;

  @ApiProperty({ type: ExtractedReceiptFieldsDto })
  extracted!: ExtractedReceiptFieldsDto;

  @ApiPropertyOptional({
    type: LedgerEntryResponseDto,
    description: 'The created entry. Present only when status is AUTO_CREATED.',
  })
  entry?: LedgerEntryResponseDto;

  @ApiPropertyOptional({
    example: 'upl_9f8c2e1a4b3d',
    description:
      'Present only when status is NEEDS_REVIEW. Expires in 30 minutes.',
  })
  uploadToken?: string;

  @ApiPropertyOptional({
    example: 'Confidence 0.62 is below the 0.85 auto-create threshold.',
    description:
      'Why this receipt needs a human. Present only when status is NEEDS_REVIEW — show it so the admin knows what to check.',
  })
  reviewReason?: string;

  @ApiPropertyOptional({
    type: DuplicateMatchDto,
    description:
      'Set when this receipt looks like one already on file. A duplicate always forces NEEDS_REVIEW — re-filing is sometimes legitimate, so the decision stays with the admin. Link `entryId` so they can compare before confirming.',
  })
  duplicate?: DuplicateMatchDto;

  constructor(partial: Partial<ScanExtractionResponseDto>) {
    Object.assign(this, partial);
  }
}
