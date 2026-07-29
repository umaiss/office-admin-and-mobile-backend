import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import { trimAndLowercase } from '../../common/transforms/string.transforms';

export class LoginDto {
  @ApiProperty({ example: 'admin@obtrack.local' })
  @IsEmail({}, { message: 'A valid email address is required.' })
  @Transform(trimAndLowercase)
  email!: string;

  @ApiProperty({ example: 'ChangeMe123!' })
  @IsString()
  // No strength rules on LOGIN — only on account creation. Rejecting a weak
  // password here would tell an attacker that no account uses it, and would
  // lock out existing users if the policy were ever tightened.
  @MinLength(1, { message: 'Password is required.' })
  // An upper bound matters: bcrypt's cost is paid before the password is even
  // compared, so accepting a 10MB "password" is a free denial-of-service.
  @MaxLength(200)
  password!: string;
}
