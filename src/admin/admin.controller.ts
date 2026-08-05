import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator';
import {
  ExcelExportService,
  XLSX_CONTENT_TYPE,
} from '../common/export/excel-export.service';
import { Role } from '../generated/prisma/enums';
import { CreateReimbursementRateDto } from '../reimbursement/dto/create-reimbursement-rate.dto';
import { ReimbursementRateService } from '../reimbursement/reimbursement-rate.service';
import { AdminExportService } from './admin-export.service';
import { AdminService } from './admin.service';
import { AdminListTasksQueryDto } from './dto/admin-list-tasks-query.dto';
import { OfficeBoyStatsQueryDto } from './dto/office-boy-stats-query.dto';
import { ReceiptsQueryDto } from './dto/receipts-query.dto';
import { ReimbursementsQueryDto } from './dto/reimbursements-query.dto';

/**
 * The admin dashboard surface.
 *
 * Every route here is ADMIN-only — office boys own and run tasks, admins observe
 * across all of them. The class-level `@Roles(Role.ADMIN)` (with the global
 * `JwtAuthGuard` + `RolesGuard`) is the whole authorisation story: there is no
 * per-task ownership to check, because an admin may see everyone's work by
 * definition.
 *
 * Route-ordering rule throughout: a literal segment is declared BEFORE its `:id`
 * sibling (`tasks/export` before `tasks/:id`, `office-boys/stats` before
 * `office-boys/:id/stats`), so the literal is matched as a route rather than
 * captured as a parameter value.
 */
@ApiTags('Admin')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({
  description: 'Authenticated, but not an administrator.',
})
@Roles(Role.ADMIN)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly exportService: AdminExportService,
    private readonly excel: ExcelExportService,
    private readonly rates: ReimbursementRateService,
  ) {}

  // --------------------------------------------------------------------------
  //  Tasks
  // --------------------------------------------------------------------------
  @Get('tasks')
  @ApiOperation({
    summary: 'List all tasks',
    description:
      "Every office boy's tasks, newest first. Filter by status, officeBoyId, " +
      'employeeId, a createdAt date range, completedToday, whether a receipt is ' +
      'attached, whether it has been submitted, or a free-text search.',
  })
  listTasks(@Query() query: AdminListTasksQueryDto) {
    return this.adminService.listAll(query);
  }

  @Get('tasks/export')
  @NoEnvelope()
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOperation({
    summary: 'Export tasks as Excel (.xlsx)',
    description:
      'The same set `GET /admin/tasks` would list (same filters), with no ' +
      'pagination, as an .xlsx workbook including the settlement amounts and ' +
      'receipt status. Capped at 10,000 rows; X-Export-Truncated says when.',
  })
  @ApiOkResponse({ description: 'An .xlsx workbook.' })
  async exportTasks(
    @Query() query: AdminListTasksQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { rows, truncated } = await this.adminService.tasksForExport(query);
    const workbook = await this.exportService.buildTasksWorkbook(rows);
    this.excel.send(res, workbook, 'tasks-export', truncated);
  }

  @Get('tasks/:id')
  @ApiOperation({
    summary: 'View any task',
    description: 'Any single task with its computed route. Admin-only.',
  })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  getTask(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.findOne(id);
  }

  // --------------------------------------------------------------------------
  //  Statistics
  // --------------------------------------------------------------------------
  @Get('stats')
  @ApiOperation({
    summary: 'Dashboard statistics',
    description:
      'Fleet-wide KPIs: task counts per status, completed today, tasks awaiting ' +
      'submission, receipts collected, total distance and duration over ' +
      'completed tasks, cash received/returned, active office boy count, and ' +
      'the current per-km rate.',
  })
  stats() {
    return this.adminService.stats();
  }

  @Get('office-boys/stats')
  @ApiOperation({
    summary: 'Statistics for every office boy',
    description:
      'One row per office boy — task counts per status, completed work, ' +
      'distance, duration, average task length, cash handled, and reimbursement ' +
      'owed — plus fleet totals. The date window applies to completed work, not ' +
      'to the per-status counts.',
  })
  officeBoyStats(@Query() query: OfficeBoyStatsQueryDto) {
    return this.adminService.officeBoyStats(query);
  }

  @Get('office-boys/stats/export')
  @NoEnvelope()
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOperation({
    summary: 'Export office boy statistics as Excel (.xlsx)',
    description:
      'The same rows as GET /admin/office-boys/stats, as a workbook.',
  })
  @ApiOkResponse({ description: 'An .xlsx workbook.' })
  async exportOfficeBoyStats(
    @Query() query: OfficeBoyStatsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { rows } = await this.adminService.officeBoyStats(query);
    const workbook = await this.exportService.buildOfficeBoyStatsWorkbook(rows);
    this.excel.send(res, workbook, 'office-boy-stats-export');
  }

  @Get('office-boys/:id/stats')
  @ApiOperation({
    summary: "One office boy's statistics",
    description:
      'The same shape as the fleet view, narrowed to one person. Returns an ' +
      'empty row list if the id is not an office boy.',
  })
  officeBoyStatsOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: OfficeBoyStatsQueryDto,
  ) {
    return this.adminService.officeBoyStats(query, id);
  }

  // --------------------------------------------------------------------------
  //  Reimbursements
  // --------------------------------------------------------------------------
  @Get('reimbursements')
  @ApiOperation({
    summary: 'Reimbursements',
    description:
      'Per office boy, derived from COMPLETED tasks: distance × the rate that ' +
      'was in force when each task ended. Each row carries a breakdown showing ' +
      'how the amount splits across rate periods. Filter by officeBoyId and a ' +
      'completion date range.',
  })
  reimbursements(@Query() query: ReimbursementsQueryDto) {
    return this.adminService.reimbursements(query);
  }

  @Get('reimbursements/export')
  @NoEnvelope()
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOperation({
    summary: 'Export reimbursements as Excel (.xlsx)',
    description:
      'The same rows as GET /admin/reimbursements, as a workbook, including ' +
      'which rates were applied to each office boy.',
  })
  @ApiOkResponse({ description: 'An .xlsx workbook.' })
  async exportReimbursements(
    @Query() query: ReimbursementsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { rows } = await this.adminService.reimbursements(query);
    const workbook = await this.exportService.buildReimbursementsWorkbook(rows);
    this.excel.send(res, workbook, 'reimbursements-export');
  }

  // --------------------------------------------------------------------------
  //  Reimbursement rate (per kilometre)
  // --------------------------------------------------------------------------
  @Get('reimbursement-rates')
  @ApiOperation({
    summary: 'Reimbursement rate history',
    description:
      'Every rate ever set, newest first, with who set it and why. A rate ' +
      'applies to tasks that ended between its effectiveFrom and the next rate.',
  })
  listRates() {
    return this.rates.list();
  }

  @Post('reimbursement-rates')
  @ApiOperation({
    summary: 'Set the reimbursement rate per kilometre',
    description:
      'Appends a new rate rather than editing the current one, so past reports ' +
      'keep showing what they were paid at. effectiveFrom defaults to now; a ' +
      'future date schedules the change.',
  })
  @ApiConflictResponse({
    description: 'A rate already starts at that exact instant.',
  })
  createRate(
    @CurrentUser('userId') adminId: string,
    @Body() dto: CreateReimbursementRateDto,
  ) {
    return this.rates.create(dto, adminId);
  }

  @Delete('reimbursement-rates/:id')
  @ApiOperation({
    summary: 'Withdraw a scheduled rate',
    description:
      'Only a rate whose effectiveFrom is still in the future can be removed. ' +
      'A rate already in force has priced completed work and is history; append ' +
      'a new rate instead.',
  })
  @ApiOkResponse({ description: 'Scheduled rate withdrawn.' })
  @ApiNotFoundResponse({ description: 'No rate with that id.' })
  @ApiConflictResponse({ description: 'That rate is already in force.' })
  removeRate(@Param('id', ParseUUIDPipe) id: string) {
    return this.rates.remove(id);
  }

  // --------------------------------------------------------------------------
  //  Receipts / petty cash
  // --------------------------------------------------------------------------
  @Get('receipts')
  @ApiOperation({
    summary: 'Receipts and settlement details (petty cash feed)',
    description:
      'Completed tasks with the amounts received and returned, the net spent, ' +
      'and the attached receipt (metadata plus a download URL). Filter by ' +
      'office boy, completion date range, whether a receipt exists, and whether ' +
      'the office boy has submitted. Totals cover the whole filtered set, not ' +
      'just the current page. Download the file itself from the receiptUrl.',
  })
  receipts(@Query() query: ReceiptsQueryDto) {
    return this.adminService.receipts(query);
  }
}
