import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  trim,
  trimAndLowercase,
} from '../../common/transforms/string.transforms';
import { Role } from '../../generated/prisma/enums';

export class CreateUserDto {
  @ApiProperty({ example: 'Bilal Ahmed' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Transform(trim)
  name!: string;

  @ApiProperty({ example: 'bilal@obtrack.local' })
  @IsEmail()
  @MaxLength(255)
  @Transform(trimAndLowercase)
  email!: string;

  @ApiProperty({
    example: 'Password123!',
    description:
      'At least 8 characters, containing an uppercase letter, a lowercase letter, and a digit.',
  })
  @IsString()
  // Length is the single most effective password rule — far more than symbol
  // requirements, which mostly push people toward "Password1!" patterns.
  @MinLength(8)
  // bcrypt silently truncates input beyond 72 bytes. Capping below that avoids
  // the surprise of two different long passwords both being accepted as valid.
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain an uppercase letter, a lowercase letter, and a number.',
  })
  password!: string;

  @ApiPropertyOptional({
    example: '+923001234567',
    description: 'International format, including the country code.',
  })
  @IsOptional()
  @IsString()
  // A permissive pattern rather than @IsPhoneNumber(): strict libraries reject
  // valid numbers from regions they model imperfectly, and a rejected phone
  // number blocks account creation entirely.
  @Matches(/^\+?[0-9\s-]{7,20}$/, {
    message: 'Phone must be 7-20 digits, optionally starting with +.',
  })
  phone?: string;

  @ApiProperty({ enum: Role, example: Role.OFFICE_BOY })
  @IsEnum(Role)
  role!: Role;
}
