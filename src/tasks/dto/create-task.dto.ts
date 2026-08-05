import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { trim } from '../../common/transforms/string.transforms';

/**
 * Body for `POST /tasks`.
 *
 * A task is created with no location — creation is deliberately decoupled from
 * GPS, because an office boy taps "create" before setting off, often with no
 * signal. Coordinates arrive later via `/start` and `/locations`.
 */
export class CreateTaskDto {
  /**
   * Idempotency key generated on the device BEFORE any network call.
   *
   * The server upserts on this, so a create retried over a flaky mobile
   * connection updates the same row instead of spawning a duplicate task.
   * Required here: every task the app creates carries one. (Tasks created from
   * the admin dashboard would omit it — but admins do not create tasks in this
   * product, so the API always expects it.)
   */
  @ApiProperty({
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    description: 'Client-generated UUID. Idempotency key — retries upsert.',
  })
  @IsUUID()
  clientTaskId!: string;

  @ApiPropertyOptional({
    example: 'Deliver documents to head office',
    description:
      'Short label. Optional — in the field an office boy often creates a task with only a description.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @Transform(trim)
  title?: string;

  @ApiProperty({ example: 'Hand the sealed envelope to reception on floor 3.' })
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  @Transform(trim)
  description!: string;

  @ApiPropertyOptional({
    example: 'Head Office, I.I. Chundrigar Road, Karachi',
    description: 'Free-text destination label. Not a coordinate.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(trim)
  destination?: string;

  /**
   * The "Top 10 Employee" this task is for, if any.
   *
   * Maps directly to the app's checkbox + dropdown: ticking "this task is for a
   * Top 10 employee" reveals the list, and the chosen employee's id is sent
   * here. Omitted entirely for an ordinary task (the checkbox left off). The
   * service verifies the id refers to an existing, active employee before
   * linking it.
   */
  @ApiPropertyOptional({
    example: '9c1e7b2a-3d4f-4a5b-8c6d-1e2f3a4b5c6d',
    description:
      'Id of the Top 10 employee this task is for. Omit for a normal task.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}
