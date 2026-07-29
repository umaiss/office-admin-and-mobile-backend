import { ApiProperty } from '@nestjs/swagger';

/**
 * The envelope every successful response is wrapped in.
 *
 * Why wrap at all? Because a client written against this API can then have ONE
 * piece of code that unwraps every response, instead of guessing whether an
 * endpoint returned an object, an array, or a bare string. It also means the
 * success and failure shapes are siblings — `success: true` vs `success: false`
 * — so a client can branch on a single field.
 *
 * The cost is a little extra nesting. That is a good trade for a public API.
 */
export class ApiSuccessResponseDto<T> {
  @ApiProperty({ example: true })
  success!: true;

  @ApiProperty({ description: 'The actual payload of the response.' })
  data!: T;

  @ApiProperty({ example: '2026-07-28T09:15:00.000Z' })
  timestamp!: string;
}

/**
 * The envelope every failed response is wrapped in.
 *
 * Note what is NOT here: no stack trace, no SQL, no internal exception class
 * name. Those go to the logs. Sending them to the client hands an attacker a
 * free map of your internals.
 */
export class ApiErrorResponseDto {
  @ApiProperty({ example: false })
  success!: false;

  @ApiProperty({ example: 404 })
  statusCode!: number;

  @ApiProperty({
    description:
      'Human-readable description. May be an array when validation fails.',
    example: 'Task not found',
  })
  message!: string | string[];

  @ApiProperty({ example: 'Not Found' })
  error!: string;

  @ApiProperty({ example: '/api/v1/tasks/3f2504e0' })
  path!: string;

  @ApiProperty({ example: '2026-07-28T09:15:00.000Z' })
  timestamp!: string;

  @ApiProperty({
    description:
      'Correlation id. Give this to support — it finds the exact log lines for this request.',
    example: 'req-1a2b3c',
    required: false,
  })
  requestId?: string;
}

/** Standard pagination metadata, used from Phase 3 onward. */
export class PaginationMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
  @ApiProperty({ example: 137 }) total!: number;
  @ApiProperty({ example: 7 }) totalPages!: number;
  @ApiProperty({ example: true }) hasNextPage!: boolean;
  @ApiProperty({ example: false }) hasPreviousPage!: boolean;
}
