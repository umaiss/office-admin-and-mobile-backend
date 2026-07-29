import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * Note what is NOT here any more: `userId`.
 *
 * The previous version required the caller to state which user they were.
 * Anything a client sends is under the client's control, so identity must never
 * come from the request body — it is derived from the server's own record of
 * who the token was issued to. Sending it also leaked user ids into request
 * bodies and logs for no benefit.
 */
export class RefreshTokenDto {
  @ApiProperty({
    description:
      'The refresh token returned by /auth/login or a previous /auth/refresh.',
    example: '3f2504e0-4f89-11d3-9a0c-0305e82c3301.Zm9vYmFyYmF6cXV4',
  })
  @IsString()
  @MinLength(20)
  refreshToken!: string;
}
