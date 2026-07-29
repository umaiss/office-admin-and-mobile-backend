import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '../auth/roles.decorator';
import { Role } from '../generated/prisma/enums';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersService } from './users.service';

/**
 * Account management.
 *
 * Every route here is admin-only.
 *
 * Until this phase, `POST /users` had no guard at all — anyone who could reach
 * the server could create themselves an ADMIN account. It stayed open only
 * because it was the sole way to create the first administrator; Phase 1's seed
 * script removed that excuse, so it is now closed.
 *
 * Two independent controls apply, and both are needed:
 *   • JwtAuthGuard (global)  — are you authenticated at all?
 *   • RolesGuard + @Roles    — are you specifically an admin?
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({
  description: 'Authenticated, but not an administrator.',
})
@Roles(Role.ADMIN)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a user account (admin only)',
    description:
      'Creates an administrator or office boy. The password is hashed with bcrypt and never returned.',
  })
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one user by id (admin only)' })
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }
}
