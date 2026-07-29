import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { AppConfigService } from '../config/app-config.service';
import { RefreshTokenModule } from '../refresh-token/refresh-token.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    UsersModule,
    RefreshTokenModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        // No presence check needed: validateEnv guarantees JWT_SECRET exists
        // and is at least 32 characters, or the app never started.
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtAccessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, RolesGuard],
  // JwtAuthGuard and RolesGuard are exported because AppModule registers them
  // as APP_GUARD — they must be resolvable from the root injector.
  exports: [AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
