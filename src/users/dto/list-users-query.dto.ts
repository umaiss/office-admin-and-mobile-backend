import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// This transform started life here, then the admin DTO reinvented the same
// field with `@Type(() => Boolean)` and inherited the exact bug the comment on
// `parseBoolean` warns about. It now lives in common/ so there is one of it.
import { parseBoolean } from '../../common/transforms/boolean.transforms';
import { trim } from '../../common/transforms/string.transforms';
import { Role } from '../../generated/prisma/enums';

/**
 * Query string for `GET /users`.
 *
 * The admin office-boy directory: the same pagination shape as the task lists,
 * plus the two filters a dashboard actually needs — role and active state — and
 * a name/email search. `@Type(() => Number)` and the global
 * `enableImplicitConversion` turn the raw string query values into real numbers
 * before validation runs.
 */
export class ListUsersQueryDto {
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
    enum: Role,
    description: 'Filter to a single role. Omit for all users.',
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({
    example: true,
    description: 'Filter by active state. Omit to include both.',
  })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: 'bil',
    description: 'Case-insensitive search across name and email.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  search?: string;
}
