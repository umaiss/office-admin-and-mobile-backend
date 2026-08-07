import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PettyCashCategory, PaymentMethod } from '../petty-cash.constants';

/**
 * Backs the "Confirm Scanned Data" step of the Scan Receipt panel. The
 * client calls `POST /petty-cash/entries/scan/extract` first to get OCR
 * suggestions, lets the admin edit them on screen, then submits this DTO
 * as plain JSON — no file re-upload here. `uploadToken` (passed as a query
 * param, not a body field) is enough to locate the file already stored by
 * the extract step.
 *
 * All fields the OCR step suggested are re-submitted here as the values
 * the admin actually confirmed, which is what gets saved on the ledger
 * entry. The raw OCR output is stored separately on PettyCashReceipt for
 * audit purposes (see confirm() in the service).
 */
export class ConfirmScanEntryDto {
  @ApiProperty({ example: 2145.5, minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({ example: 'Shell Petrol Station', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  supplier!: string;

  @ApiProperty({ enum: PettyCashCategory, example: PettyCashCategory.FUEL })
  @IsEnum(PettyCashCategory)
  category!: PettyCashCategory;

  @ApiProperty({ example: '2026-08-05' })
  @IsDateString()
  entryDate!: string;

  @ApiPropertyOptional({
    description: 'Defaults to the supplier name if not provided.',
    example: 'Refueling corporate van (Plate: DCG 1041), Mileage: 45,210 km',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: PaymentMethod, default: PaymentMethod.PETTY_CASH })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod = PaymentMethod.PETTY_CASH;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}