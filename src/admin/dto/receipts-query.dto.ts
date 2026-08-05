import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

import { parseBoolean } from '../../common/transforms/boolean.transforms';

/**
 * Query string for `GET /admin/receipts` — the petty cash feed.
 *
 * This is the screen an admin works from when booking expenses, so the filters
 * are the ones that question needs: which period, whose, has a receipt been
 * attached, and has the office boy actually handed it in yet.
 *
 * The default (`submitted` omitted) shows everything; a dashboard wanting the
 * "ready to book" queue passes `submitted=true`, and one chasing office boys
 * passes `submitted=false`.
 */
export class ReceiptsQueryDto {
  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description: 'Page, 1-based.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: 20,
    default: 20,
    description: 'Items per page, capped at 100.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    description: 'Only this office boy. Omit for everyone.',
  })
  @IsOptional()
  @IsUUID()
  officeBoyId?: string;

  @ApiPropertyOptional({
    example: '2026-08-01T00:00:00.000Z',
    description:
      'Inclusive lower bound on task completion time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-31T23:59:59.999Z',
    description:
      'Inclusive upper bound on task completion time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'true = only tasks with a receipt attached, false = only those without ' +
      '(the chase list, since a receipt is optional but usually expected).',
  })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  hasReceipt?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'true = handed in and ready to book, false = the office boy has not ' +
      'submitted yet. Omit for both.',
  })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  submitted?: boolean;
}
