import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * One GPS reading in a batch upload.
 *
 * Richer than `LocationPointDto`: the streamed points carry the quality signals
 * the noise filter needs (`accuracyMeters`, `isMoving`) and the diagnostics that
 * explain gaps in a trail (`batteryLevel`). Every extra field is optional — a
 * device that cannot supply `heading` should still be able to report its
 * position.
 */
export class LocationBatchItemDto {
  /**
   * Idempotency key generated on the device, REQUIRED. This is the field that
   * makes offline sync safe: the server upserts on it, so a batch re-sent after
   * a lost response adds nothing. On mobile networks the retry is the norm, not
   * the edge case.
   */
  @ApiProperty({
    example: 'b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e7d',
    description: 'Client-generated UUID. Idempotency key for this point.',
  })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ example: 24.8607 })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 67.0011 })
  @IsLongitude()
  longitude!: number;

  @ApiProperty({
    example: '2026-07-31T09:00:10.000Z',
    description: 'ISO-8601 UTC — when the DEVICE captured this reading.',
  })
  @IsISO8601()
  recordedAt!: string;

  @ApiPropertyOptional({
    example: 8,
    description: 'Radius of uncertainty in metres. Drives the noise filter.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  accuracyMeters?: number;

  @ApiPropertyOptional({ example: 12.5, description: 'Altitude in metres.' })
  @IsOptional()
  @IsNumber()
  altitudeMeters?: number;

  @ApiPropertyOptional({ example: 1.4, description: 'Ground speed, m/s.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  speedMetersPerSecond?: number;

  @ApiPropertyOptional({ example: 270, description: 'Heading, degrees 0–360.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  headingDegrees?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      'OS motion state. `false` means the device reports stationary.',
  })
  @IsOptional()
  @IsBoolean()
  isMoving?: boolean;

  @ApiPropertyOptional({ example: 82, description: 'Battery %, 0–100.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  batteryLevel?: number;
}

/**
 * Body for `POST /tasks/:id/locations`.
 *
 * A wrapper object rather than a bare array, so the shape has somewhere to grow
 * (a future `deviceId` or `syncedAt` belongs here, not on every point) and so
 * the batch size can be capped in one place.
 */
export class AddLocationsDto {
  @ApiProperty({
    type: [LocationBatchItemDto],
    description: 'GPS points captured since the last successful upload.',
  })
  @IsArray()
  // At least one point — an empty batch is a client bug worth surfacing.
  @ArrayMinSize(1)
  // Cap the payload so a single request cannot carry an unbounded number of
  // rows. 500 points is ~80 minutes at one fix every 10s — comfortably more
  // than a normal flush, without letting a bad client send megabytes.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LocationBatchItemDto)
  points!: LocationBatchItemDto[];
}
