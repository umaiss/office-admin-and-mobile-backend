import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { AdjustmentType } from '../../generated/prisma/enums';

export class CreateAdjustmentDto {
  @ApiProperty({ enum: AdjustmentType, example: AdjustmentType.TOP_UP })
  @IsEnum(AdjustmentType)
  type!: AdjustmentType;

  @ApiProperty({
    description:
      'Always positive. `type` determines whether this adds to or subtracts from the balance.',
    example: 1000,
    minimum: 0.01,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({
    example: 'Emergency top-up approved for month-end courier rush',
    maxLength: 500,
  })
  // Same reasoning as `description` on CreateManualEntryDto: the reason is
  // the entire audit trail for a balance movement, and '   ' is not one.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
