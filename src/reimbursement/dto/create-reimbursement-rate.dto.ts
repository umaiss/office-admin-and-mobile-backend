import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Body for `POST /admin/reimbursement-rates`.
 *
 * Setting a rate appends to a history rather than overwriting a setting, so
 * this DTO carries the *date the new rate starts from* as a first-class field
 * rather than assuming "now".
 */
export class CreateReimbursementRateDto {
  @ApiProperty({
    example: 40,
    description:
      'Amount paid per kilometre travelled on a completed task. ' +
      'Two decimal places; the currency is whatever the deployment uses.',
  })
  // maxDecimalPlaces guards the Decimal(10,2) column: a rate of 12.345 would
  // otherwise be silently rounded by Postgres and the admin would never know
  // the stored value differs from what they typed.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  ratePerKm!: number;

  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00.000Z',
    description:
      'When this rate starts applying (ISO-8601 UTC). Defaults to now. ' +
      'A future date schedules the change; a past date restates history.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    example: 'FY27 fuel adjustment approved by finance',
    description: 'Why the rate changed. Shown in the audit list.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  note?: string;
}
