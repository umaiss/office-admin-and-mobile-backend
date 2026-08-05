import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Query string for the office boy statistics endpoints and their export.
 *
 * The window is on `endedAt` — when the work finished — for the same reason the
 * reimbursement report uses it: a monthly performance review means "what was
 * completed in that month", not "what happened to be created in it".
 *
 * Task counts per status are deliberately NOT windowed. "How many tasks are
 * pending" is a question about right now; filtering it by a completion date
 * would be meaningless, since a pending task has no completion date at all.
 */
export class OfficeBoyStatsQueryDto {
  @ApiPropertyOptional({
    example: '2026-08-01T00:00:00.000Z',
    description:
      'Inclusive lower bound on task completion time (ISO-8601 UTC). ' +
      'Applies to the totals, not to the per-status counts.',
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
}
