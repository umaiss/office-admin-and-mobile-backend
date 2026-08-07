import { ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateManualEntryDto } from './create-manual-entry.dto';

/**
 * All fields optional (PartialType), and `linkedTaskId` removed entirely —
 * an entry's TASK/MANUAL origin and its task link are immutable after
 * creation. Reassigning a settled task's ledger entry to a different task
 * would corrupt both ledgers' history, so it's not exposed as an edit.
 *
 * Editing a TASK-sourced entry's amount/category/etc. IS allowed (an admin
 * correcting a miscategorised task expense is a normal workflow) — only
 * the source and task link are frozen.
 */
export class UpdateEntryDto extends PartialType(
  OmitType(CreateManualEntryDto, ['linkedTaskId'] as const),
) {}
