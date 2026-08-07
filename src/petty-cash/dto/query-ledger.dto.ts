import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PettyCashCategory, LedgerEntrySource } from '../petty-cash.constants';

/**
 * Backs the ledger table's search bar, "All Sources" dropdown, date range,
 * and category filter, plus pagination for the "Showing X to Y of Z
 * entries" footer.
 */
export class QueryLedgerDto {
  @ApiPropertyOptional({ description: '4-digit year. Defaults to the current year.', example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ description: '1-12. Omit to see the whole year.', example: 10, minimum: 1, maximum: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ enum: LedgerEntrySource, description: 'Filter by TASK vs MANUAL. Omit for all.' })
  @IsOptional()
  @IsEnum(LedgerEntrySource)
  source?: LedgerEntrySource;

  @ApiPropertyOptional({ enum: PettyCashCategory })
  @IsOptional()
  @IsEnum(PettyCashCategory)
  category?: PettyCashCategory;

  @ApiPropertyOptional({ description: 'Free-text search across description and supplier.', example: 'Aramex' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Filter to one staff member.' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
