import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsLatitude, IsLongitude } from 'class-validator';

/**
 * A single GPS fix supplied when a task is started or ended.
 *
 * This is the small, mandatory endpoint position — distinct from the streamed
 * points in `/locations`, which carry extra quality signals. Start and end need
 * only "where were you, and when".
 */
export class LocationPointDto {
  @ApiProperty({ example: 24.8607, description: 'Decimal degrees, WGS-84.' })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({ example: 67.0011, description: 'Decimal degrees, WGS-84.' })
  @IsLongitude()
  longitude!: number;

  /**
   * When the DEVICE captured this fix, ISO-8601 UTC. Supplied by the client
   * rather than stamped on arrival because with buffered/offline uploads the
   * two can differ by minutes, and it is the device time that describes when
   * the office boy was actually there.
   */
  @ApiProperty({
    example: '2026-07-31T09:00:00.000Z',
    description: 'ISO-8601 UTC timestamp of the fix, from the device.',
  })
  @IsISO8601()
  recordedAt!: string;
}
