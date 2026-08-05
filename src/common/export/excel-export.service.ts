import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { Workbook } from 'exceljs';

/** The MIME type for `.xlsx`. Long enough to be worth naming once. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Hard upper bound on rows a single export may contain.
 *
 * Without it, a filterless export of a mature database would try to build a
 * workbook of millions of rows in memory. When it bites, the caller is told via
 * the `X-Export-Truncated` header rather than silently receiving a partial file
 * that looks complete.
 */
export const EXPORT_ROW_CEILING = 10_000;

/** One column: its header, its width, and how to read it off a row. */
export interface ExcelColumn<T> {
  header: string;
  width: number;
  value: (row: T) => string | number;
}

/**
 * Builds and sends `.xlsx` workbooks.
 *
 * ## Why one service for every export
 *
 * `exceljs` is the heaviest dependency in the app, and there are now four
 * exports (tasks, hours saved, reimbursements, office boy stats). Each one
 * defining its own workbook would mean four copies of "add a sheet, bold row 1,
 * write a buffer" and four chances for one of them to forget the header row or
 * the truncation signal. Here, a caller only ever declares COLUMNS — what the
 * spreadsheet contains — and this class owns how a spreadsheet is made.
 *
 * If the export format ever changes library, this file is the entire blast
 * radius.
 */
@Injectable()
export class ExcelExportService {
  /**
   * Builds a single-sheet workbook and returns it as a Buffer.
   *
   * A Buffer rather than a stream because row counts are capped upstream at
   * `EXPORT_ROW_CEILING`, so the whole file fits comfortably in memory and the
   * controller stays a three-liner.
   */
  async build<T>(
    sheetName: string,
    columns: ExcelColumn<T>[],
    rows: T[],
  ): Promise<Buffer> {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet(sheetName);

    sheet.columns = columns.map((column, index) => ({
      header: column.header,
      // exceljs addresses rows by key; the index is a stable one that cannot
      // collide the way two columns sharing a natural name could.
      key: `c${index}`,
      width: column.width,
    }));

    // A bold header row is the one bit of styling worth the two lines: it is
    // what tells a reader "row 1 is labels, not data".
    sheet.getRow(1).font = { bold: true };

    for (const row of rows) {
      const record: Record<string, string | number> = {};
      columns.forEach((column, index) => {
        record[`c${index}`] = column.value(row);
      });
      sheet.addRow(record);
    }

    // exceljs types this as ArrayBuffer-ish; Buffer.from normalises it for the
    // Express response.
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  /**
   * Writes a built workbook to the response with the right headers.
   *
   * `truncated` sets `X-Export-Truncated`, which the dashboard reads to warn
   * that the ceiling clipped the result. That header (and `Content-Disposition`)
   * are only visible to a browser because `main.ts` lists them in the CORS
   * `exposedHeaders` — a cross-origin response hides every other header by
   * default, so adding one here without adding it there achieves nothing.
   */
  send(
    res: Response,
    workbook: Buffer,
    filenamePrefix: string,
    truncated = false,
  ): void {
    // The day boundary here is cosmetic — it only names the file — so the
    // server's own clock is fine and no reporting timezone is involved.
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filenamePrefix}-${stamp}.xlsx"`,
    );
    if (truncated) {
      res.setHeader('X-Export-Truncated', 'true');
    }
    res.send(workbook);
  }
}

/** ISO-8601 for a nullable date; empty string when absent. Times stay UTC. */
export function toIso(value: Date | null | undefined): string {
  return value ? value.toISOString() : '';
}
