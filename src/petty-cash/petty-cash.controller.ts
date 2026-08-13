import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';

import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator';
import { inlineContentDisposition } from '../common/http/content-disposition';
import { Role } from '../generated/prisma/enums';
import { ALLOWED_RECEIPT_MIME_TYPES } from '../storage/file-type';
import { RECEIPT_UPLOAD_OPTIONS } from '../storage/receipt-upload.options';
import {
  ConfirmScanEntryDto,
  CreateAdjustmentDto,
  CreateManualEntryDto,
  LedgerEntryResponseDto,
  MonthlySummaryResponseDto,
  PaginatedLedgerResponseDto,
  QueryLedgerDto,
  ScanExtractionResponseDto,
  SetOpeningBalanceDto,
  UpdateEntryDto,
} from './dto';
import { PettyCashService } from './petty-cash.service';

/**
 * The petty cash ledger.
 *
 * Every route is admin-only. Authentication and authorisation both come from
 * the guards registered globally in `AppModule` — this controller deliberately
 * does NOT re-declare them with `@UseGuards`, which would run the JWT strategy
 * (and its user lookup) a second time on every request.
 */
@ApiTags('Petty Cash')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@ApiForbiddenResponse({
  description: 'Authenticated, but not an administrator.',
})
@Roles(Role.ADMIN)
/**
 * Opts out of the `auth` throttler.
 *
 * Every throttler declared in `ThrottlerModule.forRoot` applies to EVERY route
 * — a named throttler is not opt-in, and `@Throttle({ auth: {} })` on the login
 * routes overrides that throttler's options rather than enabling it. Without
 * this, the 5-requests-per-minute limit meant to slow password guessing was
 * silently capping the whole API, so a single dashboard load 429'd.
 */
@SkipThrottle({ auth: true })
@Controller({ path: 'petty-cash', version: '1' })
export class PettyCashController {
  constructor(private readonly pettyCashService: PettyCashService) {}

  // ----------------------------------------------------------------
  //  Monthly ledger
  // ----------------------------------------------------------------

  @Post('months')
  @ApiOperation({
    summary: "Open a month's petty cash ledger",
    description:
      "Sets the opening balance for a calendar month, either by carrying forward the previous month's remaining balance (omit `amount`) or by manually defining a new opening balance (supply `amount`). This must be called before any entries — manual or task-derived — can be recorded against that month.",
  })
  @ApiCreatedResponse({
    description: 'Month opened.',
    type: MonthlySummaryResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'No previous month to carry forward from, and no manual amount supplied.',
  })
  @ApiConflictResponse({ description: 'This month is already open.' })
  openMonth(
    @Body() dto: SetOpeningBalanceDto,
    @CurrentUser('userId') adminId: string,
  ): Promise<MonthlySummaryResponseDto> {
    return this.pettyCashService.openMonth(dto, adminId);
  }

  // `year` and `month` are parsed and range-checked by pipes rather than with a
  // bare `Number()`: an unparseable segment must be a 400 the caller can act on,
  // not a NaN that reaches Prisma and surfaces as a 500.
  @Get('months/:year/:month/summary')
  @ApiOperation({
    summary: 'Get the dashboard KPI summary for a month',
    description:
      'Returns the four dashboard cards: Monthly Allocation, Total Expenses, Remaining Balance, and Total Entries. `totalExpenses` and `remainingBalance` are pre-computed and cached; `totalEntries` is counted live.',
  })
  @ApiParam({ name: 'year', example: 2026 })
  @ApiParam({ name: 'month', example: 10, description: '1-12' })
  @ApiOkResponse({ type: MonthlySummaryResponseDto })
  @ApiBadRequestResponse({
    description: 'Year or month is not a valid number.',
  })
  @ApiNotFoundResponse({
    description: 'No ledger has been opened for this month yet.',
  })
  getMonthlySummary(
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
  ): Promise<MonthlySummaryResponseDto> {
    assertMonth(year, month);
    return this.pettyCashService.getMonthlySummary(year, month);
  }

  @Post('months/:year/:month/adjustments')
  @ApiOperation({
    summary: 'Record a balance adjustment (top-up or correction)',
    description:
      'For balance movements that are not expenses — e.g. adding emergency float mid-month, or correcting the balance after a physical cash count. Returns the updated monthly summary.',
  })
  @ApiParam({ name: 'year', example: 2026 })
  @ApiParam({ name: 'month', example: 10, description: '1-12' })
  @ApiCreatedResponse({ type: MonthlySummaryResponseDto })
  @ApiBadRequestResponse({
    description: 'Year or month is not a valid number.',
  })
  @ApiNotFoundResponse({ description: 'No ledger open for this month.' })
  createAdjustment(
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
    @Body() dto: CreateAdjustmentDto,
    @CurrentUser('userId') adminId: string,
  ): Promise<MonthlySummaryResponseDto> {
    assertMonth(year, month);
    return this.pettyCashService.createAdjustment(year, month, dto, adminId);
  }

  // ----------------------------------------------------------------
  //  Ledger entries
  // ----------------------------------------------------------------

  @Get('entries')
  @ApiOperation({
    summary: 'List / search / filter ledger entries',
    description:
      'Backs the ledger table shown on the dashboard, including its search bar, source filter, category filter, date range, and pagination. Defaults to the current year if `year` is omitted, and to all months within that year if `month` is omitted.',
  })
  @ApiOkResponse({ type: PaginatedLedgerResponseDto })
  listEntries(
    @Query() query: QueryLedgerDto,
  ): Promise<PaginatedLedgerResponseDto> {
    return this.pettyCashService.listEntries(query);
  }

  @Get('entries/:id/receipt')
  // Binary response: opt out of the success envelope, or the interceptor wraps
  // the StreamableFile in `{ success, data, ... }` and Nest serialises that as
  // JSON — the caller then gets an image content type with a JSON body.
  @NoEnvelope()
  @ApiOperation({
    summary: "Download a ledger entry's receipt file",
    description:
      "Streams the receipt image/PDF for this entry — its own PettyCashReceipt for MANUAL entries, or the linked task's TaskReceipt for TASK entries. This is the URL returned as `receipt.url` on ledger entry responses.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces(...ALLOWED_RECEIPT_MIME_TYPES)
  @ApiOkResponse({
    description:
      'The receipt file, streamed as binary content. Content-Type reflects the stored file rather than being fixed.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({
    description: 'Entry not found, or has no receipt attached.',
  })
  async downloadReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, mimeType, originalName } =
      await this.pettyCashService.getReceiptStream(id);

    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': inlineContentDisposition(originalName),
    });
    return new StreamableFile(stream);
  }

  @Post('entries')
  @ApiOperation({
    summary: 'Create a manual ledger entry',
    description:
      'Backs the "New Ledger Entry — Manual" panel. For expenses that did not originate from an Office Boy task. `source` is always set to MANUAL by the server.',
  })
  @ApiCreatedResponse({ type: LedgerEntryResponseDto })
  @ApiBadRequestResponse({
    description:
      "Validation failed (see field-level errors), or no ledger open for the entry's month.",
  })
  createManualEntry(
    @Body() dto: CreateManualEntryDto,
    @CurrentUser('userId') adminId: string,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.createManualEntry(dto, adminId);
  }

  @Post('entries/scan/extract')
  @UseInterceptors(FileInterceptor('file', RECEIPT_UPLOAD_OPTIONS))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a receipt and let the extractor file it',
    description:
      'Step 1 of the "Scan Receipt" panel. Stores the file and reads the amount, vendor, date, category, and a description off it.\n\n' +
      'Check `status` on the response — there are two outcomes:\n\n' +
      '- **AUTO_CREATED** — the extraction was confident and complete, and the ledger entry is in `entry`. Nothing further to do; correct it with `PATCH /petty-cash/entries/:id` if a field is wrong.\n' +
      '- **NEEDS_REVIEW** — show the values in `extracted` for the admin to confirm or correct, tell them why using `reviewReason`, then post the confirmed values to `POST /petty-cash/entries/scan/confirm` with the `uploadToken`. The token expires after 30 minutes.\n\n' +
      "A receipt is only filed automatically when the amount, date, and category were all read, the month's ledger is open, and confidence clears the `RECEIPT_AUTOCREATE_CONFIDENCE` threshold. With no extraction configured, every scan is NEEDS_REVIEW with empty suggestions.",
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: `The receipt. One of: ${ALLOWED_RECEIPT_MIME_TYPES.join(', ')}. Max 5 MB.`,
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ScanExtractionResponseDto })
  @ApiBadRequestResponse({
    description: 'Missing, oversized, or wrong file type.',
  })
  extractFromReceipt(
    @CurrentUser('userId') adminId: string,
    // No ParseFilePipe: its FileTypeValidator only inspects the client-declared
    // mimetype, which is exactly the value we have decided not to trust. Size
    // and type are both enforced in the service against the real bytes.
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ScanExtractionResponseDto> {
    return this.pettyCashService.extractFromReceipt(adminId, file);
  }

  @Post('entries/scan/confirm')
  @ApiOperation({
    summary: 'Confirm a scanned receipt and create the ledger entry',
    description:
      'Step 2 of the "Scan Receipt" panel. Persists a MANUAL entry with the confirmed field values and attaches the previously uploaded receipt via `uploadToken`.',
  })
  @ApiQuery({ name: 'uploadToken', example: 'upl_9f8c2e1a4b3d' })
  @ApiCreatedResponse({ type: LedgerEntryResponseDto })
  @ApiNotFoundResponse({
    description: 'Upload token not found or expired — re-upload the receipt.',
  })
  @ApiBadRequestResponse({
    description: "Validation failed, or no ledger open for the entry's month.",
  })
  confirmScanEntry(
    @Query('uploadToken') uploadToken: string,
    @Body() dto: ConfirmScanEntryDto,
    @CurrentUser('userId') adminId: string,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.confirmScanEntry(uploadToken, dto, adminId);
  }

  @Patch('entries/:id')
  @ApiOperation({
    summary: 'Edit a ledger entry',
    description:
      "Any field except source and task link can be corrected — including for TASK-sourced entries (e.g. recategorising a task expense). Moving an entry's `entryDate` into a different month re-parents it to that month's ledger and recomputes both months' totals.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LedgerEntryResponseDto })
  @ApiNotFoundResponse({ description: 'Entry not found.' })
  @ApiBadRequestResponse({
    description: 'Validation failed, or the target month has no ledger open.',
  })
  updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryDto,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.updateEntry(id, dto);
  }

  @Post('entries/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark an automatically-filed entry as reviewed',
    description:
      'Clears `needsReview` and its note. Use it for the case where the admin looked at a flagged entry and found nothing to change — editing the entry via PATCH is itself an act of review and clears the flag too.\n\nFind the queue with `GET /petty-cash/entries?needsReview=true`.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LedgerEntryResponseDto })
  @ApiNotFoundResponse({ description: 'Entry not found.' })
  approveEntry(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.approveEntry(id);
  }

  @Delete('entries/:id')
  @ApiOperation({
    summary: 'Delete a ledger entry',
    description:
      "Permanently removes an entry and recomputes its month's totals. Use sparingly — correcting the amount via PATCH is preferred so the record stays in the audit trail. Deleting a TASK-sourced entry does not reopen the underlying task for re-settlement.",
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Entry deleted.' })
  @ApiNotFoundResponse({ description: 'Entry not found.' })
  async deleteEntry(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ deleted: true }> {
    await this.pettyCashService.deleteEntry(id);
    return { deleted: true };
  }
}

/**
 * Range-checks a `:year/:month` pair.
 *
 * `ParseIntPipe` guarantees an integer, not a *sensible* one — month 0 or 13
 * would otherwise sail through to a lookup that simply finds nothing and
 * reports "no ledger open", which sends the admin looking for a missing ledger
 * rather than a typo. The bounds mirror `QueryLedgerDto`.
 */
function assertMonth(year: number, month: number): void {
  if (year < 2000 || year > 2100) {
    throw new BadRequestException('year must be between 2000 and 2100.');
  }
  if (month < 1 || month > 12) {
    throw new BadRequestException('month must be between 1 and 12.');
  }
}
