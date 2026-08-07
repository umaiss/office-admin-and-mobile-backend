import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PettyCashCategory } from '../petty-cash.constants';

export class ScanExtractionResponseDto {
  @ApiProperty({
    description: 'Opaque reference to the temporarily-stored uploaded file. Expires in 30 minutes if not confirmed.',
    example: 'upl_9f8c2e1a4b3d',
  })
  uploadToken!: string;

  @ApiPropertyOptional({ example: 2145.5 })
  extractedAmount?: number;

  @ApiPropertyOptional({ example: 'Shell Petrol Station' })
  extractedVendor?: string;

  @ApiPropertyOptional({ enum: PettyCashCategory, description: 'Best-guess category based on vendor/text match.' })
  suggestedCategory?: PettyCashCategory;

  @ApiPropertyOptional({ example: '2026-10-24' })
  extractedDate?: string;

  @ApiProperty({ example: 0.86, description: 'Overall OCR confidence, 0-1. Below 0.5, the UI should prompt for manual review.' })
  confidence!: number;

  constructor(partial: Partial<ScanExtractionResponseDto>) {
    Object.assign(this, partial);
  }
}