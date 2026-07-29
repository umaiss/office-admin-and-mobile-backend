import { ApiProperty } from '@nestjs/swagger';

/**
 * The public shape of a logged-in user.
 *
 * This is deliberately a separate class from the Prisma `User` model. The model
 * has a `password` column; this does not. Because we return *this* type rather
 * than the model, it is structurally impossible to leak the password hash by
 * forgetting to strip it.
 */
export class AuthUserDto {
  @ApiProperty({ example: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
  id!: string;

  @ApiProperty({ example: 'Ahmed Khan' })
  name!: string;

  @ApiProperty({ example: 'ahmed@example.com' })
  email!: string;

  @ApiProperty({ enum: ['ADMIN', 'OFFICE_BOY'], example: 'OFFICE_BOY' })
  role!: string;

  @ApiProperty({ example: '+923001234567', nullable: true })
  phone!: string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;
}

export class AuthTokensDto {
  @ApiProperty({
    description: 'Short-lived token sent as `Authorization: Bearer <token>`.',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Long-lived token used only to obtain a new access token. Store it in secure storage, never in localStorage.',
  })
  refreshToken!: string;

  @ApiProperty({
    description: 'Seconds until the access token expires.',
    example: 900,
  })
  expiresIn!: number;
}

export class AuthResponseDto extends AuthTokensDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}
