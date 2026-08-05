import { Module } from '@nestjs/common';

import { ExcelExportService } from './excel-export.service';

/**
 * The xlsx export mechanism, shared by every module that offers a download.
 *
 * A leaf module with no dependencies of its own, so both `AdminModule` and
 * `EmployeesModule` can import it without any risk of a cycle.
 */
@Module({
  providers: [ExcelExportService],
  exports: [ExcelExportService],
})
export class ExportModule {}
