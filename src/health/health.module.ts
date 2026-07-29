import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

@Module({
  // PrismaService comes from the @Global() PrismaModule, so there is nothing
  // to import here.
  controllers: [HealthController],
})
export class HealthModule {}
