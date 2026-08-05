import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * The money side of finishing a task: what the admin handed over before the
 * errand, what came back after it, and who it was spent with.
 *
 * Every field is optional, and this is a PATCH of *the settlement as a whole* —
 * so an omitted field is not "leave the previous value", it is "the office boy
 * cleared this box". The amounts therefore fall back to `0` (the spec is
 * explicit that entering nothing means nothing was received or returned) and the
 * vendor falls back to `null` (nothing was written down). Defaulting here rather
 * than in the service means Swagger advertises the rule and there is one place
 * it can change.
 *
 * `maxDecimalPlaces: 2` matches the `Decimal(12,2)` columns. Without it, `10.999`
 * would be accepted by the API and silently rounded by Postgres, so the number
 * the office boy typed and the number in the ledger would differ.
 */
export class SettlementDto {
  @ApiPropertyOptional({
    example: 500,
    default: 0,
    description:
      'Cash received from the admin before the errand. Omit to record 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  amountReceived?: number = 0;

  @ApiPropertyOptional({
    example: 120.5,
    default: 0,
    description: 'Cash handed back to the admin afterwards. Omit to record 0.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999_999)
  amountReturned?: number = 0;

  @ApiPropertyOptional({
    example: 'Al-Fatah Superstore, Gulberg — invoice #A-4471',
    description:
      'Who the money was spent with: shop name, branch, invoice number — ' +
      'whatever the office boy writes down. Free text, so an errand to an ' +
      'unfamiliar counter is never blocked. Omit or send an empty string to ' +
      'clear it. Appears on the admin petty cash feed and the task export, and ' +
      'is covered by the task search.',
  })
  @IsOptional()
  @IsString()
  // 500 matches `destination` and `cancellationReason` — the other free-text
  // "describe this in a sentence" fields on a task.
  @MaxLength(500)
  @Transform(trim)
  vendorDetails?: string;
}
