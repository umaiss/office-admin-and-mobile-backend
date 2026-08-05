import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Body for `PATCH /users/:id`.
 *
 * Deliberately narrow: only the mutable profile fields an admin edits. `email`
 * and `role` are excluded on purpose — email is the login identity and role is
 * the authorisation boundary, so changing either is a security-sensitive act
 * that belongs behind its own explicit operation, not a general profile patch.
 * (This is the DTO-layering point the roadmap's Phase 3 calls out.)
 *
 * Every field is optional — PATCH updates only what is sent. The validators on
 * each field match `CreateUserDto`, so a name valid to create is valid to edit.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Bilal Ahmed' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name?: string;

  @ApiPropertyOptional({
    example: '+923001234567',
    description: 'International format, including the country code.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9\s-]{7,20}$/, {
    message: 'Phone must be 7-20 digits, optionally starting with +.',
  })
  phone?: string;
}
