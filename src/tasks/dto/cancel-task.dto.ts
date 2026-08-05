import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Body for `POST /tasks/:id/cancel`.
 *
 * The reason is required, not optional. A cancelled task with no explanation is
 * useless to the admin reviewing why work did not get done — "customer not
 * available" and "wrong address given" lead to very different follow-ups.
 *
 * The GPS fix (latitude/longitude/recordedAt) is OPTIONAL, unlike start and end.
 * An office boy often cancels precisely because something went wrong — including
 * being somewhere with no signal — so demanding coordinates would block the
 * cancellation entirely. When they are sent, they are stored for the audit
 * trail; `cancelledAt` itself is always stamped server-side.
 */
export class CancelTaskDto {
  @ApiProperty({
    example: 'Customer not available at the destination.',
    description: 'Why the task was cancelled. Shown to admins in reports.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  @Transform(trim)
  cancellationReason!: string;

  @ApiPropertyOptional({
    example: 24.8607,
    description: 'Decimal degrees, WGS-84. Where the task was cancelled.',
  })
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional({
    example: 67.0011,
    description: 'Decimal degrees, WGS-84. Where the task was cancelled.',
  })
  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional({
    example: '2026-07-31T09:00:00.000Z',
    description:
      'ISO-8601 UTC timestamp of the cancel fix, from the device. Informational — ' +
      'the authoritative cancellation time (`cancelledAt`) is set on the server.',
  })
  @IsOptional()
  @IsISO8601()
  recordedAt?: string;
}
