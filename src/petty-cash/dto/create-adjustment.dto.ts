import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsPositive, IsString, MaxLength } from 'class-validator';
import { AdjustmentType } from '../petty-cash.constants';

export class CreateAdjustmentDto {
  @ApiProperty({ enum: AdjustmentType, example: AdjustmentType.TOP_UP })
  @IsEnum(AdjustmentType)
  type!: AdjustmentType;

  @ApiProperty({
    description: 'Always positive. `type` determines whether this adds to or subtracts from the balance.',
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
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}