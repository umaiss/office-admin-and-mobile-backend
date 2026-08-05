import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Body for `POST /employees` (admin only).
 *
 * An employee is just a name and an optional department — they never log in, so
 * there is no email, password, or role here. Contrast with `CreateUserDto`,
 * which carries all three because a User authenticates.
 */
export class CreateEmployeeDto {
  @ApiProperty({ example: 'Ahmed Raza' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name!: string;

  @ApiPropertyOptional({
    example: 'Maintenance Dept',
    description: 'Free-text department label.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(trim)
  department?: string;
}
