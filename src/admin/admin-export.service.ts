import { Injectable } from '@nestjs/common';

import {
  ExcelExportService,
  toIso,
  type ExcelColumn,
} from '../common/export/excel-export.service';
import type {
  OfficeBoyStatsRow,
  ReimbursementRow,
  TaskExportRow,
} from './admin.service';
import type { RatePeriod } from '../reimbursement/reimbursement-rate.service';

/**
 * The column definitions for the admin's three workbooks.
 *
 * Only the *shape* of each report lives here — building and sending the file is
 * `ExcelExportService`'s job, and `exceljs` is imported nowhere but there. That
 * split means adding a report is a list of columns, and changing spreadsheet
 * library touches one file.
 *
 * The columns are the ones an operations person actually reconciles against:
 * who did what, when, how far, what it cost, and (if it failed) why. Raw GPS
 * points are deliberately absent — they belong in a route view, not a ledger.
 */
@Injectable()
export class AdminExportService {
  constructor(private readonly excel: ExcelExportService) {}

  buildTasksWorkbook(rows: TaskExportRow[]): Promise<Buffer> {
    return this.excel.build('Tasks', TASK_COLUMNS, rows);
  }

  buildReimbursementsWorkbook(rows: ReimbursementRow[]): Promise<Buffer> {
    return this.excel.build('Reimbursements', REIMBURSEMENT_COLUMNS, rows);
  }

  buildOfficeBoyStatsWorkbook(rows: OfficeBoyStatsRow[]): Promise<Buffer> {
    return this.excel.build('Office Boys', OFFICE_BOY_COLUMNS, rows);
  }

  /**
   * A second sheet is overkill for the rate history, but an admin auditing a
   * reimbursement run needs to see which rates it used — otherwise the amounts
   * are unexplainable numbers. Rendered as a leading summary block instead.
   */
  buildRatesWorkbook(periods: RatePeriod[]): Promise<Buffer> {
    return this.excel.build('Rate History', RATE_COLUMNS, periods);
  }
}

const TASK_COLUMNS: ExcelColumn<TaskExportRow>[] = [
  { header: 'Task ID', width: 38, value: (r) => r.id },
  { header: 'Title', width: 30, value: (r) => r.title ?? '' },
  { header: 'Office Boy', width: 22, value: (r) => r.officeBoy.name },
  { header: 'Email', width: 26, value: (r) => r.officeBoy.email },
  {
    header: 'Top 10 Employee',
    width: 22,
    value: (r) => r.employee?.name ?? '',
  },
  {
    header: 'Department',
    width: 20,
    value: (r) => r.employee?.department ?? '',
  },
  { header: 'Status', width: 14, value: (r) => r.status },
  { header: 'Destination', width: 30, value: (r) => r.destination ?? '' },
  { header: 'Distance (m)', width: 14, value: (r) => r.distanceMeters ?? '' },
  { header: 'Duration (s)', width: 14, value: (r) => r.durationSeconds ?? '' },
  { header: 'Amount Received', width: 17, value: (r) => r.amountReceived },
  { header: 'Amount Returned', width: 17, value: (r) => r.amountReturned },
  // The net is what actually goes into petty cash, so it is a column rather than
  // something the reader has to compute in the spreadsheet themselves.
  {
    header: 'Net Spent',
    width: 14,
    value: (r) => Math.round((r.amountReceived - r.amountReturned) * 100) / 100,
  },
  // Sits next to the net so a reader scanning the ledger sees the amount and
  // who it went to together — the pair an expense line is reconciled against.
  { header: 'Vendor', width: 32, value: (r) => r.vendorDetails ?? '' },
  { header: 'Receipt', width: 12, value: (r) => (r.receipt ? 'Yes' : 'No') },
  {
    header: 'Receipt File',
    width: 26,
    value: (r) => r.receipt?.originalName ?? '',
  },
  { header: 'Submitted At', width: 22, value: (r) => toIso(r.submittedAt) },
  { header: 'Created At', width: 22, value: (r) => toIso(r.createdAt) },
  { header: 'Started At', width: 22, value: (r) => toIso(r.startedAt) },
  { header: 'Ended At', width: 22, value: (r) => toIso(r.endedAt) },
  { header: 'Cancelled At', width: 22, value: (r) => toIso(r.cancelledAt) },
  {
    header: 'Cancellation Reason',
    width: 30,
    value: (r) => r.cancellationReason ?? '',
  },
];

const REIMBURSEMENT_COLUMNS: ExcelColumn<ReimbursementRow>[] = [
  { header: 'Office Boy', width: 24, value: (r) => r.name },
  { header: 'Email', width: 28, value: (r) => r.email },
  { header: 'Completed Tasks', width: 18, value: (r) => r.completedTasks },
  { header: 'Distance (m)', width: 16, value: (r) => r.totalDistanceMeters },
  {
    header: 'Distance (km)',
    width: 16,
    value: (r) => Math.round((r.totalDistanceMeters / 1000) * 100) / 100,
  },
  // A single task set can span a rate change, so there is no one "the rate" for
  // a row. Listing the rates applied keeps the amount explainable without
  // needing the JSON breakdown.
  {
    header: 'Rates Applied',
    width: 20,
    value: (r) => [...new Set(r.breakdown.map((b) => b.ratePerKm))].join(', '),
  },
  { header: 'Amount', width: 16, value: (r) => r.amount },
];

const OFFICE_BOY_COLUMNS: ExcelColumn<OfficeBoyStatsRow>[] = [
  { header: 'Office Boy', width: 24, value: (r) => r.name },
  { header: 'Email', width: 28, value: (r) => r.email },
  { header: 'Active', width: 10, value: (r) => (r.isActive ? 'Yes' : 'No') },
  { header: 'Total Tasks', width: 14, value: (r) => r.tasks.total },
  { header: 'Pending', width: 12, value: (r) => r.tasks.PENDING },
  { header: 'In Progress', width: 14, value: (r) => r.tasks.IN_PROGRESS },
  { header: 'Completed', width: 13, value: (r) => r.tasks.COMPLETED },
  { header: 'Cancelled', width: 13, value: (r) => r.tasks.CANCELLED },
  { header: 'Distance (m)', width: 15, value: (r) => r.totalDistanceMeters },
  { header: 'Duration (s)', width: 15, value: (r) => r.totalDurationSeconds },
  {
    header: 'Avg Duration (s)',
    width: 18,
    value: (r) => r.averageDurationSeconds,
  },
  { header: 'Amount Received', width: 17, value: (r) => r.totalAmountReceived },
  { header: 'Amount Returned', width: 17, value: (r) => r.totalAmountReturned },
  { header: 'Net Spent', width: 14, value: (r) => r.netAmount },
  { header: 'Reimbursement', width: 16, value: (r) => r.reimbursementAmount },
  { header: 'Last Task At', width: 22, value: (r) => toIso(r.lastTaskAt) },
  { header: 'Last Login At', width: 22, value: (r) => toIso(r.lastLoginAt) },
];

const RATE_COLUMNS: ExcelColumn<RatePeriod>[] = [
  { header: 'Rate per km', width: 14, value: (r) => r.ratePerKm },
  { header: 'Effective From', width: 24, value: (r) => toIso(r.from) },
  {
    header: 'Effective Until',
    width: 24,
    value: (r) => toIso(r.to) || 'current',
  },
];
