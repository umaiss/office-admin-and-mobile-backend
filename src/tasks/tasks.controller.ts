import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { NoEnvelope } from '../common/decorators/no-envelope.decorator';
import { Role } from '../generated/prisma/enums';
import { ALLOWED_RECEIPT_MIME_TYPES } from '../storage/file-type';
import { AddLocationsDto } from './dto/add-locations.dto';
import { CancelTaskDto } from './dto/cancel-task.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { EndTaskDto } from './dto/end-task.dto';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import { LocationPointDto } from './dto/location-point.dto';
import { SettlementDto } from './dto/settlement.dto';
import { TasksService } from './tasks.service';

/**
 * multer config for the receipt upload.
 *
 * `memoryStorage` rather than disk: the bytes have to be inspected (magic-byte
 * sniff) and handed to `StorageService`, which may not be a filesystem at all.
 * Writing them to a temp file first would add a second place they can leak from.
 *
 * `fileSize` is a hard stop applied while the stream is read, so an oversized
 * upload is aborted mid-transfer instead of being buffered in full and then
 * rejected — the difference between a bounded and an unbounded memory cost.
 * `files: 1` stops a caller sending a hundred parts under the same field name.
 *
 * The 5 MB literal duplicates the `MAX_RECEIPT_BYTES` default because decorator
 * arguments are evaluated at class-definition time, before Nest can inject
 * config. `TasksService.uploadReceipt` re-checks against the configured value,
 * so a deployment that lowers the limit is still enforced.
 */
const RECEIPT_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
};

/**
 * The task lifecycle and location tracking API.
 *
 * Almost every route is office-boy-only: office boys own and run tasks, admins
 * only observe. The one exception is `GET /tasks/:id`, which an admin may also
 * read — so its role check is per-route, not on the controller. The ownership
 * rule ("your own tasks only") is enforced inside the service on the verified
 * `userId` from the token, never on anything the caller sends.
 */
@ApiTags('Tasks')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@Controller({ path: 'tasks', version: '1' })
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @Roles(Role.OFFICE_BOY)
  @ApiOperation({
    summary: 'Create a task',
    description:
      'Creates a PENDING task with no location. Upserts on clientTaskId, so a ' +
      'retried offline create never produces a duplicate.',
  })
  @ApiForbiddenResponse({ description: 'Not an office boy.' })
  create(@CurrentUser('userId') userId: string, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(userId, dto);
  }

  @Get()
  @Roles(Role.OFFICE_BOY)
  @ApiOperation({
    summary: 'List my tasks (task history)',
    description:
      'Paginated, newest first, scoped to the caller. Filter by status, a ' +
      'createdAt date range, employee, whether a receipt is attached, whether ' +
      'it has been submitted, or a free-text search.',
  })
  @ApiForbiddenResponse({ description: 'Not an office boy.' })
  list(
    @CurrentUser('userId') userId: string,
    @Query() query: ListTasksQueryDto,
  ) {
    return this.tasksService.findMany(userId, query);
  }

  @Get('stats')
  @Roles(Role.OFFICE_BOY)
  @ApiOperation({
    summary: 'My statistics (KPI)',
    description:
      "The caller's own headline numbers: task counts per status, completed " +
      'today, tasks still awaiting submission, total distance/duration over ' +
      'completed tasks, cash received/returned, and reimbursement earned at the ' +
      'rate in force when each task ended.',
  })
  @ApiForbiddenResponse({ description: 'Not an office boy.' })
  stats(@CurrentUser('userId') userId: string) {
    return this.tasksService.stats(userId);
  }

  @Get(':id')
  // No @Roles here: both the owning office boy and any admin may read one task.
  // The owner-or-admin decision is made in the service, which has the task's
  // officeBoyId to compare against.
  @ApiOperation({
    summary: 'Get one task with its route',
    description: 'Readable by the task owner or any admin.',
  })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  getOne(
    @CurrentUser('userId') userId: string,
    @CurrentUser('role') role: Role,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasksService.findOne(userId, role, id);
  }

  @Post(':id/start')
  @Roles(Role.OFFICE_BOY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start a task',
    description:
      'PENDING → IN_PROGRESS, recording the start GPS fix and the start time.',
  })
  @ApiOkResponse({ description: 'Task started.' })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({ description: 'Task is not PENDING.' })
  start(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LocationPointDto,
  ) {
    return this.tasksService.start(userId, id, dto);
  }

  @Post(':id/locations')
  @Roles(Role.OFFICE_BOY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload a batch of GPS points',
    description:
      'Upserts each point on clientId, so retried batches are harmless. Accepted ' +
      'while the task is IN_PROGRESS, or briefly after it ends (late buffered ' +
      'points), in which case the route is recomputed. Does not change task status.',
  })
  @ApiOkResponse({
    description: 'Points stored. Returns accepted/received counts.',
  })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({
    description:
      'Task is not accepting locations (wrong status / past grace window).',
  })
  addLocations(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddLocationsDto,
  ) {
    return this.tasksService.addLocations(userId, id, dto);
  }

  @Post(':id/end')
  @Roles(Role.OFFICE_BOY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a task',
    description:
      'IN_PROGRESS → COMPLETED. Records the end fix, then computes distance, ' +
      'duration, and the encoded route in a single transaction. The task ' +
      'completes with settlement amounts of 0; record the real amounts with ' +
      'PATCH /tasks/:id/settlement, which is the only route that writes them.',
  })
  @ApiOkResponse({ description: 'Task completed with computed totals.' })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({ description: 'Task is not IN_PROGRESS.' })
  end(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndTaskDto,
  ) {
    return this.tasksService.end(userId, id, dto);
  }

  @Post(':id/cancel')
  @Roles(Role.OFFICE_BOY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a task',
    description:
      'PENDING or IN_PROGRESS → CANCELLED, with a required reason. A completed ' +
      'or already-cancelled task cannot be cancelled.',
  })
  @ApiOkResponse({ description: 'Task cancelled.' })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({
    description: 'Task is already completed or cancelled.',
  })
  cancel(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTaskDto,
  ) {
    return this.tasksService.cancel(userId, id, dto);
  }

  // --------------------------------------------------------------------------
  //  Settlement: amounts → receipt → submit
  // --------------------------------------------------------------------------
  @Patch(':id/settlement')
  @Roles(Role.OFFICE_BOY)
  @ApiOperation({
    summary: 'Record the amounts received and returned',
    description:
      'Sets both settlement amounts on a COMPLETED task. Omitted amounts are ' +
      'recorded as 0. Refused once the task has been submitted.',
  })
  @ApiOkResponse({ description: 'Settlement recorded.' })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({
    description: 'Task is not COMPLETED, or has already been submitted.',
  })
  settle(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettlementDto,
  ) {
    return this.tasksService.settle(userId, id, dto);
  }

  @Post(':id/receipt')
  @Roles(Role.OFFICE_BOY)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', RECEIPT_UPLOAD_OPTIONS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: `The receipt image. One of: ${ALLOWED_RECEIPT_MIME_TYPES.join(', ')}. Max 5 MB.`,
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Upload (or replace) the receipt',
    description:
      'Attaches a receipt to a COMPLETED task. The file type is verified from ' +
      "the file's own bytes, not the declared Content-Type. Re-uploading " +
      'replaces the previous receipt. Refused once the task has been submitted.',
  })
  @ApiOkResponse({ description: 'Receipt stored; returns the updated task.' })
  @ApiBadRequestResponse({
    description: 'Missing, oversized, or wrong file type.',
  })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({
    description: 'Task is not COMPLETED, or has already been submitted.',
  })
  uploadReceipt(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    // No ParseFilePipe: its FileTypeValidator only inspects the client-declared
    // mimetype, which is exactly the value we have decided not to trust. Size
    // and type are both enforced in the service against the real bytes.
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('A receipt file is required.');
    }
    return this.tasksService.uploadReceipt(userId, id, file);
  }

  @Get(':id/receipt')
  // No @Roles: the owning office boy or any admin may download it — the admin
  // needs it to book the expense. Ownership is checked in the service.
  @NoEnvelope()
  @ApiProduces(...ALLOWED_RECEIPT_MIME_TYPES)
  @ApiOperation({
    summary: 'Download the receipt',
    description:
      'Streams the stored receipt. Readable by the task owner or any admin.',
  })
  @ApiOkResponse({ description: 'The receipt file.' })
  @ApiNotFoundResponse({ description: 'No such task, or it has no receipt.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  async downloadReceipt(
    @CurrentUser('userId') userId: string,
    @CurrentUser('role') role: Role,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const receipt = await this.tasksService.getReceipt(userId, role, id);

    res.setHeader('Content-Type', receipt.mimeType);
    res.setHeader('Content-Length', receipt.sizeBytes);
    // `inline` so the dashboard can render it in an <img>/<iframe> rather than
    // forcing a download. The filename is quoted and stripped of quotes and
    // control characters so a crafted upload name cannot inject a header.
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${sanitiseFilename(receipt.originalName)}"`,
    );

    receipt.stream.pipe(res);
  }

  @Delete(':id/receipt')
  @Roles(Role.OFFICE_BOY)
  @ApiOperation({
    summary: 'Remove the receipt',
    description:
      'Deletes the attached receipt so a wrong photo can be replaced. Refused ' +
      'once the task has been submitted.',
  })
  @ApiOkResponse({ description: 'Receipt removed.' })
  @ApiNotFoundResponse({ description: 'No such task, or it has no receipt.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({
    description: 'Task is not COMPLETED, or has already been submitted.',
  })
  deleteReceipt(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasksService.deleteReceipt(userId, id);
  }

  @Post(':id/submit')
  @Roles(Role.OFFICE_BOY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the task',
    description:
      'The final step: freezes the amounts and receipt and hands the task to ' +
      "the admin's petty cash feed. A receipt is not required. Submitting " +
      'twice is a conflict, not a no-op.',
  })
  @ApiOkResponse({ description: 'Task submitted.' })
  @ApiNotFoundResponse({ description: 'No task with that id.' })
  @ApiForbiddenResponse({ description: "Another office boy's task." })
  @ApiConflictResponse({
    description: 'Task is not COMPLETED, or was already submitted.',
  })
  submit(
    @CurrentUser('userId') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tasksService.submit(userId, id);
  }
}

/**
 * Makes an uploaded filename safe to place inside a `Content-Disposition`
 * header.
 *
 * A filename is attacker-controlled text. Left as-is, a name containing `"` or
 * a CRLF would break out of the quoted string and let the uploader append
 * arbitrary response headers. Stripping quotes, backslashes and control
 * characters — and capping the length — removes that entirely; the result is
 * only ever a display hint.
 */
function sanitiseFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return (cleaned || 'receipt').slice(0, 100);
}
