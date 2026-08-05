import { Module } from '@nestjs/common';

import { ReimbursementModule } from '../reimbursement/reimbursement.module';
import { StorageModule } from '../storage/storage.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * The tasks + location-tracking + settlement feature.
 *
 * `StorageModule` supplies the receipt storage driver, and `ReimbursementModule`
 * the rate history the office boy's KPI screen prices their distance against.
 * Both are leaf modules, so importing them here cannot create a cycle with
 * `AdminModule`, which imports this one.
 *
 * PrismaService is provided by the global PrismaModule, so it need not be
 * imported. TasksService is exported because AdminService reuses `findOne` to
 * keep the admin and office boy views of a single task byte-identical.
 */
@Module({
  imports: [StorageModule, ReimbursementModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
