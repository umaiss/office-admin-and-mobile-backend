import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SetOpeningBalanceDto {
  @ApiProperty({ example: 2026, minimum: 2000, maximum: 2100 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 11, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional({
    description:
      'Manually define the opening balance. Omit this field entirely to carry forward the previous month\'s remaining balance instead.',
    example: 5000,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiPropertyOptional({ maxLength: 500, example: 'Reset to standard monthly float per Admin Dept policy' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}