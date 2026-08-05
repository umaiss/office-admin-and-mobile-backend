import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /users/:id/reset-password`.
 *
 * The admin supplies the new password directly (no email round-trip in this
 * product). The rules are the exact ones `CreateUserDto` enforces, so a reset
 * can never set a password weaker than one the account could have been created
 * with. The service revokes every session on the account after a reset, so the
 * old password's live tokens die with it.
 */
export class ResetPasswordDto {
  @ApiProperty({
    example: 'NewPassword123!',
    description:
      'At least 8 characters, containing an uppercase letter, a lowercase letter, and a digit.',
  })
  @IsString()
  @MinLength(8)
  // bcrypt silently truncates beyond 72 bytes — cap below it so two different
  // long passwords are never both accepted as the same.
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'Password must contain an uppercase letter, a lowercase letter, and a number.',
  })
  newPassword!: string;
}
