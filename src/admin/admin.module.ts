import { Module } from '@nestjs/common';

import { ExportModule } from '../common/export/export.module';
import { ReimbursementModule } from '../reimbursement/reimbursement.module';
import { TasksModule } from '../tasks/tasks.module';
import { AdminExportService } from './admin-export.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * The admin dashboard feature: views across every office boy's work, the
 * petty-cash receipts feed, the per-kilometre rate, and the xlsx exports.
 *
 * Imports `TasksModule` for its exported `TasksService`, so the single-task view
 * reuses the exact same allowlist and route-loading logic the office boy path
 * uses — one definition, no drift. `ReimbursementModule` supplies the rate
 * history and the money calculation shared with the office boy's KPI screen, and
 * `ExportModule` the workbook builder. Both are leaf modules, so importing them
 * alongside `TasksModule` (which imports them too) creates no cycle.
 *
 * PrismaService comes from the global PrismaModule and needs no import here.
 */
@Module({
  imports: [TasksModule, ReimbursementModule, ExportModule],
  controllers: [AdminController],
  providers: [AdminService, AdminExportService],
})
export class AdminModule {}
