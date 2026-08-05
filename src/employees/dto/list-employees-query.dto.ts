import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Parses a boolean from a query string.
 *
 * `@Type(() => Boolean)` cannot be used here: `Boolean('false')` is `true`, so
 * `?isActive=false` would silently mean the opposite of what the caller asked.
 * This maps the two literal strings explicitly and leaves anything else for
 * `@IsBoolean()` to reject.
 */
function parseBoolean({ value }: TransformFnParams): unknown {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value as unknown;
}

/**
 * Query string for `GET /employees`.
 *
 * The same pagination shape as the user and task lists, plus the two filters the
 * admin directory needs — active state and a name/department search. The office
 * boy's dropdown calls this endpoint too, but the controller forces
 * `isActive: true` for that use; here it stays a free filter for admins.
 */
export class ListEmployeesQueryDto {
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
    example: true,
    description: 'Filter by active state. Omit to include both.',
  })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: 'ahmed',
    description: 'Case-insensitive search across name and department.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  search?: string;
}
