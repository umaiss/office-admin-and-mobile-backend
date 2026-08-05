import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Query string for `GET /employees/hours-saved`, its export, and
 * `GET /employees/:id/stats`.
 *
 * The window is on `endedAt`, not `createdAt`: "hours saved in August" means
 * hours of errand-running that *finished* in August. A task created on the 31st
 * and completed on the 1st belongs to September's total, because that is when
 * the time was actually spent.
 */
export class HoursSavedQueryDto {
  @ApiPropertyOptional({
    example: '2026-08-01T00:00:00.000Z',
    description:
      'Inclusive lower bound on task completion time (ISO-8601 UTC). ' +
      'Omit for all time.',
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
