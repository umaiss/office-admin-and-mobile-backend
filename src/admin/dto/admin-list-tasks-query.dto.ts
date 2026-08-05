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
 * Query string for `GET /admin/tasks` and `GET /admin/tasks/export`.
 *
 * The admin list is the mirror image of the office boy's own list: instead of
 * being hard-scoped to the caller, it spans every office boy and offers the
 * filters an operations dashboard needs. The export endpoint deliberately reuses
 * this same DTO — you export exactly the set you filtered — so the two can never
 * disagree about what "the current view" means.
 *
 * `@Type(() => Number)` plus the global `enableImplicitConversion` turns the
 * string query values into real numbers before validation runs. Booleans use
 * `parseBoolean` instead — see the comment on `completedToday`.
 */
export class AdminListTasksQueryDto {
  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description: 'Page number, 1-based. Ignored by the export endpoint.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: 20,
    default: 20,
    description:
      'Items per page, capped at 100. Ignored by the export endpoint.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    enum: TaskStatus,
    description:
      'Filter to a single status. `CANCELLED` here is just this filter with that value.',
  })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    description: 'Only tasks belonging to this office boy.',
  })
  @IsOptional()
  @IsUUID()
  officeBoyId?: string;

  @ApiPropertyOptional({
    example: '2026-07-01T00:00:00.000Z',
    description: 'Inclusive lower bound on task creation time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-07-31T23:59:59.999Z',
    description: 'Inclusive upper bound on task creation time (ISO-8601 UTC).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Shortcut for "completed today": COMPLETED tasks whose endedAt falls in ' +
      'the current reporting day (see REPORT_TZ_OFFSET_MINUTES). Overrides the ' +
      'status and date filters.',
  })
  @IsOptional()
  // NOT `@Type(() => Boolean)`. That calls `Boolean('false')`, which is `true`,
  // so `?completedToday=false` used to switch the override ON — silently pinning
  // every result to today when the caller had explicitly asked for the opposite.
  @Transform(parseBoolean)
  @IsBoolean()
  completedToday?: boolean;

  @ApiPropertyOptional({
    example: '9c1b5a4e-1f2d-4b8e-9a3c-77d1e2f3a4b5',
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
      'true = only tasks the office boy has submitted, false = still outstanding.',
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
