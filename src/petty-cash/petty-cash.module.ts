import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { PettyCashController } from './petty-cash.controller';
import { PettyCashService } from './petty-cash.service';
import { ReceiptDuplicateService } from './receipt-duplicate.service';
import { ReceiptExtractionService } from './receipt-extraction.service';

/**
 * Exports PettyCashService so the Task module can inject it and call
 * `createFromTask()` from its `submit()` handler — see "Data flow" in the
 * module documentation for the integration contract between the two
 * modules.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [PettyCashController],
  providers: [
    PettyCashService,
    ReceiptExtractionService,
    ReceiptDuplicateService,
  ],
  // ReceiptExtractionService is exported for the Task module: an office boy's
  // receipt is read at upload, which happens in TasksService.
  exports: [PettyCashService, ReceiptExtractionService],
})
export class PettyCashModule {}
