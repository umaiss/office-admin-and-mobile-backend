import { Module } from '@nestjs/common';

import { RefreshTokenModule } from '../refresh-token/refresh-token.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [RefreshTokenModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
