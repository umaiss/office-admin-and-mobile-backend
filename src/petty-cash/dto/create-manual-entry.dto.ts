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

export class CreateManualEntryDto {
  @ApiProperty({
    description: 'Amount spent, in the ledger currency (PKR). Must be greater than zero.',
    example: 2145.5,
    minimum: 0.01,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiProperty({
    enum: PettyCashCategory,
    description: 'Expense category, matches the ledger dashboard\'s "Category" column.',
    example: PettyCashCategory.OFFICE_SUPPLIES,
  })
  @IsEnum(PettyCashCategory)
  category!: PettyCashCategory;

  @ApiProperty({
    description: 'What the expense was for.',
    example: 'Printer ink cartridges and A4 paper restock',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @ApiPropertyOptional({
    description: 'Supplier / vendor name.',
    example: 'Aramex Courier',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supplier?: string;

  @ApiProperty({
    description: 'Date the expense occurred (not the date it was entered into the system). ISO 8601 date.',
    example: '2026-08-05',
  })
  @IsDateString()
  entryDate!: string;

  @ApiPropertyOptional({
    enum: PaymentMethod,
    description: 'How the expense was paid. Defaults to PETTY_CASH.',
    default: PaymentMethod.PETTY_CASH,
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod = PaymentMethod.PETTY_CASH;

  @ApiPropertyOptional({
    description: 'Staff member this expense relates to, if any.',
    example: 'b3f1c2e4-2a6d-4e1a-9c3f-7a8e6d2b5f10',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description:
      'Optionally link this manual entry to an existing task for reference (rare — most manual entries have no task). Do not use this to settle a task; task settlement always goes through the task-submit flow.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  linkedTaskId?: string;

  @ApiPropertyOptional({
    description: 'Free-text notes.',
    example: 'Urgent restock, approved verbally by Farid',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}