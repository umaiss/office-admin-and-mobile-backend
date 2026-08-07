import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiBadRequestResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/authenticated-request';
import { PettyCashService } from './petty-cash.service';
import {
  CreateManualEntryDto,
  ConfirmScanEntryDto,
  UpdateEntryDto,
  QueryLedgerDto,
  SetOpeningBalanceDto,
  CreateAdjustmentDto,
  LedgerEntryResponseDto,
  PaginatedLedgerResponseDto,
  MonthlySummaryResponseDto,
  ScanExtractionResponseDto,
} from './dto';

@ApiTags('Petty Cash')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('petty-cash')
export class PettyCashController {
  constructor(private readonly pettyCashService: PettyCashService) {}

  // ----------------------------------------------------------------
  //  Monthly ledger
  // ----------------------------------------------------------------

  @Post('months')
  @Roles('ADMIN')
  @ApiOperation({
    summary: "Open a month's petty cash ledger",
    description:
      'Sets the opening balance for a calendar month, either by carrying forward the previous month\'s remaining balance (omit `amount`) or by manually defining a new opening balance (supply `amount`). This must be called before any entries — manual or task-derived — can be recorded against that month.',
  })
  @ApiCreatedResponse({ description: 'Month opened.', type: MonthlySummaryResponseDto })
  @ApiBadRequestResponse({ description: 'No previous month to carry forward from, and no manual amount supplied.' })
  @ApiConflictResponse({ description: 'This month is already open.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
  @ApiForbiddenResponse({ description: 'Caller is not an Admin.' })
  openMonth(
    @Body() dto: SetOpeningBalanceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MonthlySummaryResponseDto> {
    return this.pettyCashService.openMonth(dto, user.userId);
  }

  @Get('months/:year/:month/summary')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Get the dashboard KPI summary for a month',
    description:
      'Returns the four dashboard cards: Monthly Allocation, Total Expenses, Remaining Balance, and Total Entries. `totalExpenses` and `remainingBalance` are pre-computed and cached; `totalEntries` is counted live.',
  })
  @ApiParam({ name: 'year', example: 2026 })
  @ApiParam({ name: 'month', example: 10, description: '1-12' })
  @ApiOkResponse({ type: MonthlySummaryResponseDto })
  @ApiNotFoundResponse({ description: 'No ledger has been opened for this month yet.' })
  getMonthlySummary(
    @Param('year') year: string,
    @Param('month') month: string,
  ): Promise<MonthlySummaryResponseDto> {
    return this.pettyCashService.getMonthlySummary(Number(year), Number(month));
  }

  @Post('months/:year/:month/adjustments')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Record a balance adjustment (top-up or correction)',
    description:
      'For balance movements that are not expenses — e.g. adding emergency float mid-month, or correcting the balance after a physical cash count. Returns the updated monthly summary.',
  })
  @ApiParam({ name: 'year', example: 2026 })
  @ApiParam({ name: 'month', example: 10 })
  @ApiCreatedResponse({ type: MonthlySummaryResponseDto })
  @ApiNotFoundResponse({ description: 'No ledger open for this month.' })
  createAdjustment(
    @Param('year') year: string,
    @Param('month') month: string,
    @Body() dto: CreateAdjustmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MonthlySummaryResponseDto> {
    return this.pettyCashService.createAdjustment(Number(year), Number(month), dto, user.userId);
  }

  // ----------------------------------------------------------------
  //  Ledger entries
  // ----------------------------------------------------------------

  @Get('entries')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'List / search / filter ledger entries',
    description:
      'Backs the ledger table shown on the dashboard, including its search bar, source filter, category filter, date range, and pagination. Defaults to the current year if `year` is omitted, and to all months within that year if `month` is omitted.',
  })
  @ApiOkResponse({ type: PaginatedLedgerResponseDto })
  listEntries(@Query() query: QueryLedgerDto): Promise<PaginatedLedgerResponseDto> {
    return this.pettyCashService.listEntries(query);
  }

  @Get('entries/:id/receipt')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Download a ledger entry\'s receipt file',
    description:
      'Streams the receipt image/PDF for this entry — its own PettyCashReceipt for MANUAL entries, or the linked task\'s TaskReceipt for TASK entries. This is the URL returned as `receipt.url` on ledger entry responses.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('image/jpeg', 'image/png', 'application/pdf')
  @ApiOkResponse({
    description:
      'The receipt file, streamed as binary content. Content-Type reflects the stored file (image/jpeg, image/png, or application/pdf) rather than being fixed.',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({ description: 'Entry not found, or has no receipt attached.' })
  async downloadReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, mimeType, originalName } = await this.pettyCashService.getReceiptStream(id);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `inline; filename="${originalName}"`,
    });
    return new StreamableFile(stream);
  }

  @Post('entries')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Create a manual ledger entry',
    description:
      'Backs the "New Ledger Entry — Manual" panel. For expenses that did not originate from an Office Boy task. `source` is always set to MANUAL by the server.',
  })
  @ApiCreatedResponse({ type: LedgerEntryResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed (see field-level errors), or no ledger open for the entry\'s month.' })
  createManualEntry(
    @Body() dto: CreateManualEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.createManualEntry(dto, user.userId);
  }

  @Post('entries/scan/extract')
  @Roles('ADMIN')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a receipt and get OCR-extracted field suggestions',
    description:
      'Step 1 of the "Scan Receipt" panel. Stores the file and attempts to extract amount, vendor, and date. Nothing is persisted to the ledger yet — the client shows the extracted values for the admin to confirm or correct, then calls `POST /petty-cash/entries/scan/confirm` with the returned `uploadToken`. The token expires after 30 minutes if not confirmed.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ type: ScanExtractionResponseDto })
  @ApiBadRequestResponse({ description: 'No file uploaded, unsupported file type, or file exceeds 5MB.' })
  @UseInterceptors(FileInterceptor('file'))
  extractFromReceipt(@UploadedFile() file: Express.Multer.File): Promise<ScanExtractionResponseDto> {
    return this.pettyCashService.extractFromReceipt(file);
  }

  @Post('entries/scan/confirm')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Confirm a scanned receipt and create the ledger entry',
    description:
      'Step 2 of the "Scan Receipt" panel. Persists a MANUAL entry with the confirmed field values and attaches the previously uploaded receipt via `uploadToken`.',
  })
  @ApiQuery({ name: 'uploadToken', example: 'upl_9f8c2e1a4b3d' })
  @ApiCreatedResponse({ type: LedgerEntryResponseDto })
  @ApiNotFoundResponse({ description: 'Upload token not found or expired — re-upload the receipt.' })
  @ApiBadRequestResponse({ description: 'Validation failed, or no ledger open for the entry\'s month.' })
  confirmScanEntry(
    @Query('uploadToken') uploadToken: string,
    @Body() dto: ConfirmScanEntryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.confirmScanEntry(uploadToken, dto, user.userId);
  }

  @Patch('entries/:id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Edit a ledger entry',
    description:
      'Any field except source and task link can be corrected — including for TASK-sourced entries (e.g. recategorising a task expense). Moving an entry\'s `entryDate` into a different month re-parents it to that month\'s ledger and recomputes both months\' totals.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LedgerEntryResponseDto })
  @ApiNotFoundResponse({ description: 'Entry not found.' })
  @ApiBadRequestResponse({ description: 'Validation failed, or the target month has no ledger open.' })
  updateEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryDto,
  ): Promise<LedgerEntryResponseDto> {
    return this.pettyCashService.updateEntry(id, dto);
  }

  @Delete('entries/:id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Delete a ledger entry',
    description:
      'Permanently removes an entry and recomputes its month\'s totals. Use sparingly — correcting the amount via PATCH is preferred so the record stays in the audit trail. Deleting a TASK-sourced entry does not reopen the underlying task for re-settlement.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ description: 'Entry deleted.' })
  @ApiNotFoundResponse({ description: 'Entry not found.' })
  async deleteEntry(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: true }> {
    await this.pettyCashService.deleteEntry(id);
    return { deleted: true };
  }
}