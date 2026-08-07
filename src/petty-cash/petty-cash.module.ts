import { Module } from '@nestjs/common';
import { PettyCashController } from './petty-cash.controller';
import { PettyCashService } from './petty-cash.service';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';

/**
 * Exports PettyCashService so the Task module can inject it and call
 * `createFromTask()` from its `submit()` handler — see "Data flow" in the
 * module documentation for the integration contract between the two
 * modules.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [PettyCashController],
  providers: [PettyCashService],
  exports: [PettyCashService],
})
export class PettyCashModule {}
