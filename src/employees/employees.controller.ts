import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { HoursSavedQueryDto } from './dto/hours-saved-query.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesService } from './employees.service';

/**
 * The "Top 10 Employee" directory and its Hours-Saved report.
 *
 * Employees are the people office boys run errands FOR — not system users. Most
 * routes are admin-only (create, edit, activate, the report). The one exception
 * is `GET /employees`, which any authenticated user may read: the office boy's
 * task-creation screen needs it to populate the "choose an employee" dropdown.
 * That route is forced to active-only here so the dropdown never offers a
 * deactivated name; the per-route `@Roles(Role.ADMIN)` on everything else is the
 * rest of the authorisation story (global `JwtAuthGuard` + `RolesGuard`).
 */
@ApiTags('Employees')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@Controller({ path: 'employees', version: '1' })
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly excel: ExcelExportService,
  ) {}

  @Post()
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Create an employee (admin only)',
    description:
      'Adds a Top 10 employee — a name and optional department. At most 10 ' +
      'employees may be active at once.',
  })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiConflictResponse({ description: 'The Top 10 is already full.' })
  create(@Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(dto);
  }

  @Get()
  // No @Roles: an office boy needs this to fill the task-creation dropdown.
  @ApiOperation({
    summary: 'List employees',
    description:
      'Admins get the full directory and may filter by active state or search. ' +
      'Office boys always get active employees only — the dropdown must never ' +
      'offer a deactivated name.',
  })
  findMany(
    @CurrentUser('role') role: Role,
    @Query() query: ListEmployeesQueryDto,
  ) {
    // Previously this pinned `isActive: true` for everyone, which quietly made
    // the documented `?isActive=false` filter dead and left an admin with no way
    // to see deactivated employees at all. The dropdown's requirement is about
    // the OFFICE BOY, so scope the override to that role rather than the route.
    return this.employeesService.findMany(
      role === Role.ADMIN ? query : { ...query, isActive: true },
    );
  }

  // Declared BEFORE `:id` so the literal segment `hours-saved` is matched as a
  // route, not captured as an `:id` value — the same ordering guarantee the
  // admin controller uses for `tasks/export` before `tasks/:id`.
  @Get('hours-saved')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Hours saved per employee (admin only)',
    description:
      'Employees ranked by the office-boy time their COMPLETED tasks consumed, ' +
      'expressed as hours saved, plus the collective totals underneath. ' +
      'Optionally windowed by task completion date. Powers the dedicated tab.',
  })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  hoursSaved(@Query() query: HoursSavedQueryDto) {
    return this.employeesService.hoursSaved(query);
  }

  @Get('hours-saved/export')
  @Roles(Role.ADMIN)
  @NoEnvelope()
  @ApiProduces(XLSX_CONTENT_TYPE)
  @ApiOperation({
    summary: 'Export hours saved as Excel (.xlsx) (admin only)',
    description:
      'The same rows and totals as GET /employees/hours-saved, with the same ' +
      'date window, as a workbook. The totals are appended as a final row.',
  })
  @ApiOkResponse({ description: 'An .xlsx workbook.' })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  async exportHoursSaved(
    @Query() query: HoursSavedQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const { rows, totals } = await this.employeesService.hoursSaved(query);

    // The totals ride along as one extra row rather than a separate sheet, so
    // the collective figure the spec asks for is impossible to miss and survives
    // being copied out of Excel into an email.
    const withTotals = [
      ...rows,
      {
        employeeId: '',
        name: 'TOTAL',
        department: '',
        isActive: true,
        completedTasks: totals.completedTasks,
        totalDurationSeconds: totals.totalDurationSeconds,
        totalDistanceMeters: totals.totalDistanceMeters,
        hoursSaved: totals.totalHoursSaved,
      },
    ];

    const workbook = await this.excel.build(
      'Hours Saved',
      HOURS_SAVED_COLUMNS,
      withTotals,
    );
    this.excel.send(res, workbook, 'hours-saved-export');
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Fetch one employee by id (admin only)' })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiNotFoundResponse({ description: 'No employee with that id.' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.findByIdOrThrow(id);
  }

  @Get(':id/stats')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: "One employee's complete statistics (admin only)",
    description:
      'Task counts per status, completed tasks, hours saved, distance, average ' +
      'task duration, and first/last activity. Optionally windowed by completion date.',
  })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiNotFoundResponse({ description: 'No employee with that id.' })
  stats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: HoursSavedQueryDto,
  ) {
    return this.employeesService.employeeStats(id, query);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Update an employee (admin only)',
    description: 'Edits name and department. Active state has its own routes.',
  })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiNotFoundResponse({ description: 'No employee with that id.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(id, dto);
  }

  @Post(':id/activate')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Activate an employee (admin only)' })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiNotFoundResponse({ description: 'No employee with that id.' })
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.setActive(id, true);
  }

  @Post(':id/deactivate')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deactivate an employee (admin only)',
    description:
      'Removes the employee from the dropdown and blocks new task links. ' +
      'Historical tasks and hours-saved totals are unaffected.',
  })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiNotFoundResponse({ description: 'No employee with that id.' })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.setActive(id, false);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @ApiOperation({
    summary: 'Delete an employee (admin only)',
    description:
      'Permanently removes an employee who has no tasks — the mistyped-entry ' +
      'case. An employee with tasks is refused with 409, because deleting them ' +
      'would rewrite the hours-saved history their tasks are the basis of; ' +
      'deactivate instead.',
  })
  @ApiOkResponse({ description: 'Employee deleted.' })
  @ApiForbiddenResponse({ description: 'Not an administrator.' })
  @ApiNotFoundResponse({ description: 'No employee with that id.' })
  @ApiConflictResponse({
    description: 'Employee has linked tasks; deactivate instead.',
  })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.employeesService.remove(id);
  }
}

/** Columns for the hours-saved workbook. Declared once, next to the route. */
const HOURS_SAVED_COLUMNS = [
  { header: 'Employee', width: 24, value: (r: HoursSavedExportRow) => r.name },
  {
    header: 'Department',
    width: 22,
    value: (r: HoursSavedExportRow) => r.department ?? '',
  },
  {
    header: 'Active',
    width: 10,
    value: (r: HoursSavedExportRow) => (r.isActive ? 'Yes' : 'No'),
  },
  {
    header: 'Completed Tasks',
    width: 18,
    value: (r: HoursSavedExportRow) => r.completedTasks,
  },
  {
    header: 'Total Time (s)',
    width: 16,
    value: (r: HoursSavedExportRow) => r.totalDurationSeconds,
  },
  {
    header: 'Hours Saved',
    width: 14,
    value: (r: HoursSavedExportRow) => r.hoursSaved,
  },
  {
    header: 'Distance (m)',
    width: 14,
    value: (r: HoursSavedExportRow) => r.totalDistanceMeters,
  },
];

/** The row shape the workbook above reads, including the appended TOTAL line. */
interface HoursSavedExportRow {
  name: string;
  department: string | null;
  isActive: boolean;
  completedTasks: number;
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  hoursSaved: number;
}
