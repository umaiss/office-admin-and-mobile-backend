import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { parseBoolean } from '../../common/transforms/boolean.transforms';
import { trim } from '../../common/transforms/string.transforms';
import { TaskStatus } from '../../generated/prisma/enums';

/**
 * Query string for `GET /tasks` — the office boy's own task history.
 *
 * Deliberately the same filter vocabulary as the admin's list (see
 * `AdminListTasksQueryDto`), minus `officeBoyId`: the office boy's scope comes
 * from their token and is not negotiable. Both DTOs feed the shared
 * `buildTaskWhere`, so "filter by date range" means the same thing on both
 * screens.
 *
 * Defaults live here rather than in the service so Swagger advertises them and a
 * caller sending no query gets a sensible page 1. `@Type(() => Number)` plus the
 * global `enableImplicitConversion` turns the string query values into real
 * numbers before validation runs — but note that booleans use `parseBoolean`
 * instead, because `Boolean('false')` is `true`.
 */
export class ListTasksQueryDto {
  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description: 'Page number, 1-based.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: 20,
    default: 20,
    description: 'Items per page. Capped so one request cannot pull thousands.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    enum: TaskStatus,
    description: "Filter to a single status. Omit for all of the OB's tasks.",
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    example: '2026-08-01T00:00:00.000Z',
    description: 'Inclusive lower bound on task creation time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-08-31T23:59:59.999Z',
    description: 'Inclusive upper bound on task creation time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    description: 'Only tasks run for this Top 10 employee.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'true = only tasks with a receipt attached, false = only those without.',
  })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  hasReceipt?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'true = only tasks already handed in, false = only those still ' +
      'outstanding. The office boy\'s "still to submit" list is `false`.',
  })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  submitted?: boolean;

  @ApiPropertyOptional({
    example: 'bank',
    description:
      'Case-insensitive search across title, description, and destination.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  search?: string;
}
