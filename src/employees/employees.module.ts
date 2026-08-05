import { Module } from '@nestjs/common';

import { ExportModule } from '../common/export/export.module';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

/**
 * The "Top 10 Employee" directory feature.
 *
 * Employees are who office boys run errands for. This module owns their CRUD,
 * the office-boy-facing list that fills the task-creation dropdown, and the
 * admin Hours-Saved report and its xlsx export. PrismaService comes from the
 * global PrismaModule and needs no import here. The service is exported in case
 * a later module wants to read employee data through it, though the tasks module
 * validates employees via Prisma directly and so does not depend on it.
 */
@Module({
  imports: [ExportModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
