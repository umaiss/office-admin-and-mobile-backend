import { Module } from '@nestjs/common';

import { PettyCashModule } from '../petty-cash/petty-cash.module';
import { ReimbursementModule } from '../reimbursement/reimbursement.module';
import { StorageModule } from '../storage/storage.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * The tasks + location-tracking + settlement feature.
 *
 * `StorageModule` supplies the receipt storage driver, `ReimbursementModule`
 * the rate history the office boy's KPI screen prices their distance against,
 * and `PettyCashModule` lets TasksService book a task's settlement into the
 * petty cash ledger on submit (see `TasksService.submit()`). All three are
 * leaf modules, so importing them here cannot create a cycle with
 * `AdminModule`, which imports this one.
 *
 * PrismaService is provided by the global PrismaModule, so it need not be
 * imported. TasksService is exported because AdminService reuses `findOne` to
 * keep the admin and office boy views of a single task byte-identical.
 */
@Module({
  imports: [StorageModule, ReimbursementModule, PettyCashModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}