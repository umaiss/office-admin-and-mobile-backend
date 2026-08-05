import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Body for `PATCH /employees/:id` (admin only).
 *
 * Every field optional — PATCH edits only what is sent. `isActive` is excluded
 * on purpose: activation/deactivation is its own explicit operation
 * (`/activate`, `/deactivate`), the same split the users module uses, so a
 * profile edit can never silently flip an employee's visibility.
 */
export class UpdateEmployeeDto {
  @ApiPropertyOptional({ example: 'Ahmed Raza' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name?: string;

  @ApiPropertyOptional({ example: 'Maintenance Dept' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  department?: string;
}
