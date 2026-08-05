import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * Query string for `GET /admin/reimbursements`.
 *
 * Reimbursement is only ever computed over COMPLETED tasks — you do not pay for
 * work that is still in progress, cancelled, or not yet started — so there is no
 * status filter here; that scope is fixed in the service. What an admin does need
 * is to narrow by person and by pay period, which is exactly these three
 * optional fields.
 */
export class ReimbursementsQueryDto {
  @ApiPropertyOptional({
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    description: 'Only this office boy. Omit for everyone.',
  })
  @IsOptional()
  @IsUUID()
  officeBoyId?: string;

  @ApiPropertyOptional({
    example: '2026-07-01T00:00:00.000Z',
    description:
      'Inclusive lower bound on task completion time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-07-31T23:59:59.999Z',
    description:
      'Inclusive upper bound on task completion time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
