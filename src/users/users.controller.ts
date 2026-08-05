import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { Roles } from '../auth/roles.decorator';
import { Role } from '../generated/prisma/enums';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateUserDto } from './dto/update-user.dto';
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

  @Get()
  @ApiOperation({
    summary: 'List users (admin only)',
    description:
      'Paginated directory. Filter by role and active state, or search across name and email.',
  })
  findMany(@Query() query: ListUsersQueryDto) {
    return this.usersService.findMany(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one user by id (admin only)' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a user profile (admin only)',
    description:
      'Edits mutable profile fields (name, phone). Email and role are immutable here by design.',
  })
  @ApiNotFoundResponse({ description: 'No user with that id.' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Activate a user account (admin only)' })
  @ApiNotFoundResponse({ description: 'No user with that id.' })
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.setActive(id, true);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deactivate a user account (admin only)',
    description:
      'Soft-deletes the account and revokes all of its refresh tokens, so live sessions stop immediately.',
  })
  @ApiNotFoundResponse({ description: 'No user with that id.' })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.setActive(id, false);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reset a user password (admin only)',
    description:
      'Sets an admin-supplied password and revokes all existing sessions on the account. The hash is never returned.',
  })
  @ApiNotFoundResponse({ description: 'No user with that id.' })
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.usersService.resetPassword(id, dto.newPassword);
  }
}
