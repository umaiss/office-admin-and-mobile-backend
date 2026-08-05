import { Workbook } from 'exceljs';

import { ExcelExportService } from '../common/export/excel-export.service';
import { TaskStatus } from '../generated/prisma/enums';
import { AdminExportService } from './admin-export.service';
import type {
  OfficeBoyStatsRow,
  ReimbursementRow,
  TaskExportRow,
} from './admin.service';

/**
 * Bridges a `@types/node` v24 vs exceljs typing variance.
 *
 * Node 24's `Buffer` is generic (`Buffer<ArrayBufferLike>`), but exceljs's
 * bundled `xlsx.load` still expects the older invariant `Buffer`. The value is a
 * real Buffer at runtime — this cast only reconciles the two type worlds so the
 * assertion below can round-trip it. It changes nothing the test actually checks.
 */
function asLoadable(buffer: Buffer): Parameters<Workbook['xlsx']['load']>[0] {
  return buffer as unknown as Parameters<Workbook['xlsx']['load']>[0];
}

/** Reopens a produced buffer and hands back the named sheet. */
async function reopen(buffer: Buffer, sheetName: string) {
  const workbook = new Workbook();
  await workbook.xlsx.load(asLoadable(buffer));
  const sheet = workbook.getWorksheet(sheetName);
  expect(sheet).toBeDefined();
  return sheet!;
}

/** Header text → 1-based column index, so assertions do not count commas. */
function columnIndex(
  sheet: ReturnType<Workbook['getWorksheet']>,
  header: string,
) {
  const headerRow = sheet!.getRow(1);
  for (let i = 1; i <= headerRow.cellCount; i += 1) {
    if (headerRow.getCell(i).value === header) return i;
  }
  throw new Error(`No column headed "${header}"`);
}

/**
 * The export service's whole job is a faithful row/column mapping into a valid
 * `.xlsx`. We don't re-test exceljs; we test that the buffer it hands back is a
 * real workbook and that a row's fields land in the right cells — including the
 * nullable ones the mapper defaults to blank, and the settlement columns an
 * admin reconciles petty cash against.
 */
describe('AdminExportService', () => {
  const service = new AdminExportService(new ExcelExportService());

  const row = (overrides: Partial<TaskExportRow> = {}): TaskExportRow => ({
    id: 'task-1',
    title: 'Deliver documents',
    status: TaskStatus.COMPLETED,
    destination: 'Main branch',
    distanceMeters: 1234,
    durationSeconds: 600,
    amountReceived: 500,
    amountReturned: 120.5,
    vendorDetails: 'Al-Fatah Superstore, Gulberg',
    submittedAt: new Date('2026-07-31T08:20:00.000Z'),
    cancellationReason: null,
    createdAt: new Date('2026-07-31T08:00:00.000Z'),
    startedAt: new Date('2026-07-31T08:05:00.000Z'),
    endedAt: new Date('2026-07-31T08:15:00.000Z'),
    cancelledAt: null,
    officeBoy: { name: 'Bilal', email: 'bilal@obtrack.local' },
    employee: null,
    receipt: { originalName: 'slip.jpg', uploadedAt: new Date() },
    ...overrides,
  });

  describe('tasks workbook', () => {
    it('produces a non-empty buffer that reopens as a workbook with a header row', async () => {
      const buffer = await service.buildTasksWorkbook([row()]);
      expect(buffer.length).toBeGreaterThan(0);

      const sheet = await reopen(buffer, 'Tasks');
      expect(sheet.getRow(1).getCell(1).value).toBe('Task ID');
    });

    it('maps a row into cells and blanks absent optional fields', async () => {
      const buffer = await service.buildTasksWorkbook([
        row({
          destination: null,
          distanceMeters: null,
          durationSeconds: null,
          cancelledAt: null,
          cancellationReason: null,
          vendorDetails: null,
          receipt: null,
        }),
      ]);

      const sheet = await reopen(buffer, 'Tasks');
      const dataRow = sheet.getRow(2);

      expect(dataRow.getCell(columnIndex(sheet, 'Task ID')).value).toBe(
        'task-1',
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Office Boy')).value).toBe(
        'Bilal',
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Destination')).value).toBe('');
      expect(dataRow.getCell(columnIndex(sheet, 'Distance (m)')).value).toBe(
        '',
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Receipt')).value).toBe('No');
      expect(dataRow.getCell(columnIndex(sheet, 'Receipt File')).value).toBe(
        '',
      );
      // A blank cell, not the string "null" — this sheet is read by a person.
      expect(dataRow.getCell(columnIndex(sheet, 'Vendor')).value).toBe('');
    });

    it('carries the settlement amounts and the derived net an admin books', async () => {
      const buffer = await service.buildTasksWorkbook([row()]);
      const sheet = await reopen(buffer, 'Tasks');
      const dataRow = sheet.getRow(2);

      expect(dataRow.getCell(columnIndex(sheet, 'Amount Received')).value).toBe(
        500,
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Amount Returned')).value).toBe(
        120.5,
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Net Spent')).value).toBe(
        379.5,
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Vendor')).value).toBe(
        'Al-Fatah Superstore, Gulberg',
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Receipt')).value).toBe('Yes');
      expect(dataRow.getCell(columnIndex(sheet, 'Receipt File')).value).toBe(
        'slip.jpg',
      );
    });
  });

  describe('reimbursements workbook', () => {
    const reimbursementRow = (
      overrides: Partial<ReimbursementRow> = {},
    ): ReimbursementRow => ({
      officeBoyId: 'ob1',
      name: 'Bilal',
      email: 'bilal@obtrack.local',
      completedTasks: 4,
      totalDistanceMeters: 12_345,
      amount: 380.25,
      breakdown: [
        {
          ratePerKm: 25,
          from: new Date(0),
          to: new Date('2026-08-01T00:00:00.000Z'),
          completedTasks: 2,
          distanceMeters: 6000,
          amount: 150,
        },
        {
          ratePerKm: 40,
          from: new Date('2026-08-01T00:00:00.000Z'),
          to: null,
          completedTasks: 2,
          distanceMeters: 6345,
          amount: 253.8,
        },
      ],
      ...overrides,
    });

    it('lists every distinct rate that priced the row, so the amount is explainable', async () => {
      const buffer = await service.buildReimbursementsWorkbook([
        reimbursementRow(),
      ]);
      const sheet = await reopen(buffer, 'Reimbursements');
      const dataRow = sheet.getRow(2);

      // A task set spanning a rate change has no single "the rate".
      expect(dataRow.getCell(columnIndex(sheet, 'Rates Applied')).value).toBe(
        '25, 40',
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Distance (km)')).value).toBe(
        12.35,
      );
      expect(dataRow.getCell(columnIndex(sheet, 'Amount')).value).toBe(380.25);
    });
  });

  describe('office boy stats workbook', () => {
    const statsRow = (): OfficeBoyStatsRow => ({
      officeBoyId: 'ob1',
      name: 'Bilal',
      email: 'bilal@obtrack.local',
      isActive: true,
      lastLoginAt: null,
      tasks: {
        total: 9,
        [TaskStatus.PENDING]: 2,
        [TaskStatus.IN_PROGRESS]: 1,
        [TaskStatus.COMPLETED]: 5,
        [TaskStatus.CANCELLED]: 1,
      },
      completedTasks: 5,
      totalDistanceMeters: 8000,
      totalDurationSeconds: 5400,
      averageDurationSeconds: 1080,
      totalAmountReceived: 1200,
      totalAmountReturned: 300,
      netAmount: 900,
      reimbursementAmount: 200,
      lastTaskAt: new Date('2026-08-03T10:00:00.000Z'),
    });

    it('breaks the per-status counts out into their own columns', async () => {
      const buffer = await service.buildOfficeBoyStatsWorkbook([statsRow()]);
      const sheet = await reopen(buffer, 'Office Boys');
      const dataRow = sheet.getRow(2);

      expect(dataRow.getCell(columnIndex(sheet, 'Total Tasks')).value).toBe(9);
      expect(dataRow.getCell(columnIndex(sheet, 'Completed')).value).toBe(5);
      expect(dataRow.getCell(columnIndex(sheet, 'Cancelled')).value).toBe(1);
      expect(dataRow.getCell(columnIndex(sheet, 'Net Spent')).value).toBe(900);
      expect(dataRow.getCell(columnIndex(sheet, 'Reimbursement')).value).toBe(
        200,
      );
      // A never-logged-in office boy blanks rather than printing "null".
      expect(dataRow.getCell(columnIndex(sheet, 'Last Login At')).value).toBe(
        '',
      );
    });
  });

  describe('rate history workbook', () => {
    it('renders the open-ended current period as "current" rather than blank', async () => {
      const buffer = await service.buildRatesWorkbook([
        {
          from: new Date(0),
          to: new Date('2026-08-01T00:00:00.000Z'),
          ratePerKm: 25,
        },
        { from: new Date('2026-08-01T00:00:00.000Z'), to: null, ratePerKm: 40 },
      ]);
      const sheet = await reopen(buffer, 'Rate History');

      expect(
        sheet.getRow(3).getCell(columnIndex(sheet, 'Effective Until')).value,
      ).toBe('current');
    });
  });
});
