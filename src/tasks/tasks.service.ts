import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';

import { AppConfigService } from '../config/app-config.service';
import { buildPaginationMeta } from '../common/pagination/paginate';
import {
  decimalSumToNumber,
  decimalToNumber,
} from '../common/serialization/decimal';
import { todayUtcRange } from '../common/time/today-range';
import { Role, TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementRateService } from '../reimbursement/reimbursement-rate.service';
import { sniffMimeType } from '../storage/file-type';
import { StorageService } from '../storage/storage.service';
import {
  computeRoute,
  DEFAULT_ACCURACY_THRESHOLD_METERS,
  GeoPoint,
} from './distance';
import { AddLocationsDto } from './dto/add-locations.dto';
import { CancelTaskDto } from './dto/cancel-task.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { EndTaskDto } from './dto/end-task.dto';
import { ListTasksQueryDto } from './dto/list-tasks-query.dto';
import { LocationPointDto } from './dto/location-point.dto';
import { SettlementDto } from './dto/settlement.dto';
import { buildTaskWhere } from './task-filters';

/**
 * The fields safe to return for a task, as a Prisma `select`.
 *
 * Same reasoning as `PUBLIC_USER_SELECT`: an allowlist is stronger than
 * remembering to strip fields. Everything a task screen needs is here; the
 * (potentially large) `route.encodedPolyline` is deliberately NOT loaded by the
 * list view — only by the single-task fetch, which asks for it explicitly.
 *
 * The receipt's METADATA is included (a list needs to show a paperclip icon)
 * but never its bytes — those are streamed by `GET /tasks/:id/receipt`.
 */
export const TASK_SELECT = {
  id: true,
  clientTaskId: true,
  title: true,
  description: true,
  destination: true,
  status: true,
  officeBoyId: true,
  startedAt: true,
  endedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  startLatitude: true,
  startLongitude: true,
  endLatitude: true,
  endLongitude: true,
  cancelLatitude: true,
  cancelLongitude: true,
  distanceMeters: true,
  durationSeconds: true,
  amountReceived: true,
  amountReturned: true,
  vendorDetails: true,
  submittedAt: true,
  employeeId: true,
  employee: { select: { id: true, name: true, department: true } },
  receipt: {
    select: {
      id: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      uploadedAt: true,
    },
  },
  createdAt: true,
  updatedAt: true,
} as const;

/** A task row exactly as `TASK_SELECT` reads it, before serialisation. */
type TaskRow = {
  amountReceived: unknown;
  amountReturned: unknown;
  [key: string]: unknown;
};

/**
 * Converts a selected task row into the shape the API returns.
 *
 * The only job here is money: `amountReceived`/`amountReturned` are Prisma
 * `Decimal` instances, and `JSON.stringify` turns those into strings. Every
 * route that returns a task goes through this so a client never has to wonder
 * whether a numeric field arrives as `500` or `"500"`.
 *
 * Also derives `netAmount` — received minus returned, what the errand actually
 * cost — because every screen that shows the two amounts also shows the
 * difference, and computing it in one place stops three clients doing it three
 * slightly different ways.
 */
export function toTaskResponse<T extends TaskRow>(row: T) {
  const amountReceived = decimalToNumber(row.amountReceived as never) ?? 0;
  const amountReturned = decimalToNumber(row.amountReturned as never) ?? 0;

  return {
    ...row,
    amountReceived,
    amountReturned,
    netAmount: Math.round((amountReceived - amountReturned) * 100) / 100,
  };
}

/**
 * How long after a task ends we still accept GPS points for it.
 *
 * A phone that regained signal seconds after the office boy tapped "end" will
 * flush the points it buffered while offline. Rejecting them would lose the
 * tail of the journey and understate the distance. Ten minutes comfortably
 * covers a normal flush without leaving a completed task editable forever.
 *
 * A named constant rather than an env var on purpose: it keeps this change
 * contained to the tasks module (no shared `env.schema.ts` edit for a teammate
 * to merge), and it is a business rule, not a per-environment knob.
 */
export const LATE_POINT_GRACE_MS = 10 * 60 * 1000;

/** The subset of a task the service needs to make authorisation/state decisions. */
type TaskGuardRow = {
  id: string;
  officeBoyId: string;
  status: TaskStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  submittedAt: Date | null;
};

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly rates: ReimbursementRateService,
    private readonly config: AppConfigService,
  ) {}

  // --------------------------------------------------------------------------
  //  #1 Create
  // --------------------------------------------------------------------------
  /**
   * Creates a task, or returns the existing one if this `clientTaskId` was
   * already seen.
   *
   * The upsert is what makes an offline create safe to retry: the device
   * generates `clientTaskId` before the first network call, so a retried
   * request lands on the same key and updates nothing rather than spawning a
   * duplicate task. `update: {}` — a retry must not overwrite a task the office
   * boy may have already started; it is a pure no-op.
   */
  async create(userId: string, dto: CreateTaskDto) {
    // A Top 10 employee link is validated here, not at the DTO layer, because
    // "exists and is still active" is a database fact. Reject an unknown or
    // deactivated employee rather than silently persisting a dangling id.
    if (dto.employeeId) {
      await this.assertActiveEmployee(dto.employeeId);
    }

    const task = await this.prisma.task.upsert({
      where: { clientTaskId: dto.clientTaskId },
      update: {},
      create: {
        clientTaskId: dto.clientTaskId,
        title: dto.title,
        description: dto.description,
        destination: dto.destination,
        employeeId: dto.employeeId,
        officeBoyId: userId,
        status: TaskStatus.PENDING,
      },
      select: TASK_SELECT,
    });

    return toTaskResponse(task);
  }

  // --------------------------------------------------------------------------
  //  #2 List (mine, paginated, optional status)
  // --------------------------------------------------------------------------
  /**
   * The office boy's own tasks. Always scoped to `officeBoyId = userId` — a
   * caller cannot widen this to see anyone else's work, because the id comes
   * from the token, not the query.
   *
   * `findMany` and `count` run together in one transaction so the total and the
   * page are drawn from the same snapshot; without it a task created between
   * the two queries could make `total` disagree with the rows returned.
   */
  async findMany(userId: string, query: ListTasksQueryDto) {
    // `officeBoyId` comes from the token and is applied here, not taken from the
    // query — that single line is what makes this list unwidenable. Everything
    // else is the same filter vocabulary the admin list uses.
    const where = buildTaskWhere({ ...query, officeBoyId: userId });

    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        select: TASK_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      items: items.map(toTaskResponse),
      meta: buildPaginationMeta(query.page, query.limit, total),
    };
  }

  // --------------------------------------------------------------------------
  //  My statistics (office boy's own dashboard)
  // --------------------------------------------------------------------------
  /**
   * The office boy's own headline numbers, hard-scoped to `officeBoyId = userId`
   * so a caller can only ever see their own totals — the id comes from the
   * token, never the request. Cheap aggregates run in one transaction so they
   * describe a single consistent moment.
   */
  async stats(userId: string) {
    const { start, end } = todayUtcRange(
      new Date(),
      this.config.reportTzOffsetMinutes,
    );

    const [
      byStatus,
      total,
      completedToday,
      completedTotals,
      pendingSubmission,
    ] = await this.prisma.$transaction([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { officeBoyId: userId },
        orderBy: { status: 'asc' },
        _count: { _all: true },
      }),
      this.prisma.task.count({ where: { officeBoyId: userId } }),
      this.prisma.task.count({
        where: {
          officeBoyId: userId,
          status: TaskStatus.COMPLETED,
          endedAt: { gte: start, lt: end },
        },
      }),
      this.prisma.task.aggregate({
        where: { officeBoyId: userId, status: TaskStatus.COMPLETED },
        _sum: {
          distanceMeters: true,
          durationSeconds: true,
          amountReceived: true,
          amountReturned: true,
        },
      }),
      // "Finished, but not handed in yet" — the office boy's own to-do count.
      this.prisma.task.count({
        where: {
          officeBoyId: userId,
          status: TaskStatus.COMPLETED,
          submittedAt: null,
        },
      }),
    ]);

    // Kept outside the transaction above: it issues one query per rate period,
    // which cannot be expressed as a fixed tuple. The figures are independent
    // aggregates, so reading them a moment apart cannot make them contradict
    // each other the way a page and its total could.
    const reimbursement = await this.rates.forOfficeBoy(userId);

    const counts: Record<TaskStatus, number> = {
      [TaskStatus.PENDING]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };
    // Prisma widens `_count` to a union inside a $transaction tuple; the runtime
    // shape for `_count: { _all: true }` is always `{ _all: number }`.
    const byStatusRows = byStatus as unknown as {
      status: TaskStatus;
      _count: { _all: number };
    }[];
    for (const row of byStatusRows) {
      counts[row.status] = row._count._all;
    }

    const totalAmountReceived = decimalSumToNumber(
      completedTotals._sum.amountReceived,
    );
    const totalAmountReturned = decimalSumToNumber(
      completedTotals._sum.amountReturned,
    );

    return {
      tasks: { total, ...counts },
      completedToday,
      pendingSubmission,
      totalDistanceMeters: completedTotals._sum.distanceMeters ?? 0,
      totalDurationSeconds: completedTotals._sum.durationSeconds ?? 0,
      totalAmountReceived,
      totalAmountReturned,
      netAmount:
        Math.round((totalAmountReceived - totalAmountReturned) * 100) / 100,
      reimbursementAmount: reimbursement.amount,
    };
  }

  // --------------------------------------------------------------------------
  //  #3 Get one (owner or admin), with route
  // --------------------------------------------------------------------------
  /**
   * One task in full, including its computed route.
   *
   * Access rule: the owning office boy, or any admin. An office boy asking for
   * a task that is not theirs gets `403`, not `404` — we already know the task
   * exists, and pretending otherwise would be a lie that complicates debugging.
   * (The information leaked by a 403 here — "a task with this id exists" — is
   * negligible next to the honesty it buys.)
   */
  async findOne(userId: string, role: Role, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        ...TASK_SELECT,
        route: {
          select: {
            encodedPolyline: true,
            distanceMeters: true,
            pointCount: true,
            rawPointCount: true,
            computedAt: true,
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found.');
    }

    if (role !== Role.ADMIN && task.officeBoyId !== userId) {
      throw new ForbiddenException('This task belongs to another office boy.');
    }

    return toTaskResponse(task);
  }

  // --------------------------------------------------------------------------
  //  #4 Start (PENDING -> IN_PROGRESS)
  // --------------------------------------------------------------------------
  async start(userId: string, taskId: string, dto: LocationPointDto) {
    const task = await this.loadOwnedTask(userId, taskId);

    // State machine, enforced in code because the database cannot express it.
    if (task.status !== TaskStatus.PENDING) {
      throw new ConflictException(
        `Cannot start a task that is ${task.status}. Only PENDING tasks can be started.`,
      );
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.IN_PROGRESS,
        startedAt: new Date(),
        startLatitude: dto.latitude,
        startLongitude: dto.longitude,
      },
      select: TASK_SELECT,
    });

    return toTaskResponse(updated);
  }

  // --------------------------------------------------------------------------
  //  #5 Batch location upload (decoupled from status)
  // --------------------------------------------------------------------------
  /**
   * Stores a batch of GPS points. Upserts on `clientId` via
   * `createMany({ skipDuplicates: true })`, so a batch re-sent after a lost
   * response adds nothing — the safety that makes offline sync correct.
   *
   * This endpoint does NOT change task status: tracking and lifecycle are
   * separate concerns. Points are accepted while the task is IN_PROGRESS, or
   * while it is COMPLETED but still inside the late-point grace window — in
   * which case the route and distance are recomputed so the trail includes the
   * points the phone flushed just after "end".
   */
  async addLocations(userId: string, taskId: string, dto: AddLocationsDto) {
    const task = await this.loadOwnedTask(userId, taskId);

    const withinGrace =
      task.status === TaskStatus.COMPLETED &&
      task.endedAt !== null &&
      Date.now() - task.endedAt.getTime() <= LATE_POINT_GRACE_MS;

    if (task.status !== TaskStatus.IN_PROGRESS && !withinGrace) {
      throw new ConflictException(
        `Cannot accept locations for a task that is ${task.status}.`,
      );
    }

    const result = await this.prisma.taskLocation.createMany({
      data: dto.points.map((p) => ({
        clientId: p.clientId,
        taskId,
        latitude: p.latitude,
        longitude: p.longitude,
        accuracyMeters: p.accuracyMeters,
        altitudeMeters: p.altitudeMeters,
        speedMetersPerSecond: p.speedMetersPerSecond,
        headingDegrees: p.headingDegrees,
        isMoving: p.isMoving,
        batteryLevel: p.batteryLevel,
        recordedAt: new Date(p.recordedAt),
      })),
      // Upsert semantics keyed on the unique `clientId`: a duplicate point from
      // a retried batch is silently skipped rather than erroring the whole call.
      skipDuplicates: true,
    });

    // Late points changed the trail of an already-completed task — its cached
    // distance and stored route are now stale, so recompute them.
    if (withinGrace && result.count > 0) {
      await this.recomputeRoute(taskId);
    }

    return { accepted: result.count, received: dto.points.length };
  }

  // --------------------------------------------------------------------------
  //  #6 End (IN_PROGRESS -> COMPLETED) + compute route/distance/duration
  // --------------------------------------------------------------------------
  /**
   * Completes a task and computes its totals in a single transaction, so a task
   * is never left COMPLETED without the route and distance that reports depend
   * on. If the computation throws, the whole thing rolls back and the task
   * stays IN_PROGRESS — retryable, rather than stuck half-finished.
   */
  async end(userId: string, taskId: string, dto: EndTaskDto) {
    const task = await this.loadOwnedTask(userId, taskId);

    if (task.status !== TaskStatus.IN_PROGRESS) {
      throw new ConflictException(
        `Cannot end a task that is ${task.status}. Only IN_PROGRESS tasks can be ended.`,
      );
    }

    const endedAt = new Date();
    const durationSeconds = task.startedAt
      ? Math.max(
          0,
          Math.round((endedAt.getTime() - task.startedAt.getTime()) / 1000),
        )
      : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const computation = await this.computeAndPersistRoute(tx, taskId);

      return tx.task.update({
        where: { id: taskId },
        data: {
          status: TaskStatus.COMPLETED,
          endedAt,
          endLatitude: dto.latitude,
          endLongitude: dto.longitude,
          distanceMeters: computation.distanceMeters,
          durationSeconds,
          // No settlement amounts here on purpose — `settle` is the only writer
          // of those columns. See the note on `EndTaskDto` for why two routes
          // writing them was a trap rather than a convenience. A task therefore
          // completes with the defaults of 0, meaning "nothing entered yet".
        },
        select: TASK_SELECT,
      });
    });

    return toTaskResponse(updated);
  }

  // --------------------------------------------------------------------------
  //  #8 Settle (record the money, after ending)
  // --------------------------------------------------------------------------
  /**
   * Records what the office boy received from and returned to the admin, and
   * who the money was spent with.
   *
   * A separate route from `end` because the product flow is a wizard — end the
   * task, then enter the settlement, then attach a receipt, then submit — and
   * each of those screens has to be able to save on its own. It is also how a
   * mistyped amount gets corrected, since the whole record freezes at `submit`.
   *
   * Omitted fields are RESET, not left alone. This is a PATCH of "the
   * settlement" as a whole, not of individual fields: an office boy who clears
   * the "returned" box and saves means zero, and silently keeping the previous
   * value would be the wrong reading of that gesture. The amounts fall back to
   * 0, the vendor to `null`.
   *
   * That semantic is also why the client must PRE-FILL this form from the task
   * before showing it — a screen that saves an empty form wipes the settlement.
   */
  async settle(userId: string, taskId: string, dto: SettlementDto) {
    const task = await this.loadOwnedTask(userId, taskId);
    this.assertSettleable(task, 'record the settlement for');

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        amountReceived: dto.amountReceived ?? 0,
        amountReturned: dto.amountReturned ?? 0,
        // An empty string is the same gesture as an omitted field — the box was
        // cleared — so both land on NULL rather than storing '' as a distinct,
        // meaningless third state that every reader would have to handle.
        vendorDetails: dto.vendorDetails ? dto.vendorDetails : null,
      },
      select: TASK_SELECT,
    });

    return toTaskResponse(updated);
  }

  // --------------------------------------------------------------------------
  //  #9 Submit (freeze the record for petty cash)
  // --------------------------------------------------------------------------
  /**
   * The last step of the office boy's flow. Stamps `submittedAt`, after which
   * the amounts and the receipt can no longer be changed and the task appears on
   * the admin's petty cash feed.
   *
   * Not idempotent on purpose: submitting twice is a `409`, not a silent no-op.
   * A double submit means the client thinks it has something new to hand in, and
   * quietly agreeing would hide that. The receipt stays optional — the spec is
   * explicit that not every errand produces one.
   */
  async submit(userId: string, taskId: string) {
    const task = await this.loadOwnedTask(userId, taskId);

    if (task.status !== TaskStatus.COMPLETED) {
      throw new ConflictException(
        `Cannot submit a task that is ${task.status}. Only COMPLETED tasks can be submitted.`,
      );
    }

    if (task.submittedAt !== null) {
      throw new ConflictException('This task has already been submitted.');
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { submittedAt: new Date() },
      select: TASK_SELECT,
    });

    return toTaskResponse(updated);
  }

  // --------------------------------------------------------------------------
  //  #7 Cancel (PENDING | IN_PROGRESS -> CANCELLED)
  // --------------------------------------------------------------------------
  async cancel(userId: string, taskId: string, dto: CancelTaskDto) {
    const task = await this.loadOwnedTask(userId, taskId);

    // A finished task — COMPLETED or already CANCELLED — is terminal.
    if (
      task.status !== TaskStatus.PENDING &&
      task.status !== TaskStatus.IN_PROGRESS
    ) {
      throw new ConflictException(
        `Cannot cancel a task that is ${task.status}.`,
      );
    }

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.CANCELLED,
        cancelledAt: new Date(),
        cancellationReason: dto.cancellationReason,
        // Optional: an office boy may cancel with no signal and send no fix.
        // When present these describe where the task was abandoned.
        cancelLatitude: dto.latitude,
        cancelLongitude: dto.longitude,
      },
      select: TASK_SELECT,
    });

    return toTaskResponse(updated);
  }

  // --------------------------------------------------------------------------
  //  #10 Receipt (upload / download / remove)
  // --------------------------------------------------------------------------
  /**
   * Stores the receipt image for a task, replacing any previous one.
   *
   * ## Trusting the bytes, not the label
   *
   * The multipart part's `Content-Type` is written by the client and can say
   * anything. The type is therefore re-derived here from the file's leading
   * bytes, and a mismatch is rejected — otherwise `shell.php` renamed to
   * `receipt.jpg` would be stored and served back as an image.
   *
   * ## Order of operations on replace
   *
   * The row is written first, and only then is the old object unlinked. The
   * reverse order has a window where the database points at a file that no
   * longer exists; this order's worst case is an orphaned file on disk, which
   * costs bytes rather than breaking a download.
   */
  async uploadReceipt(
    userId: string,
    taskId: string,
    file: { buffer: Buffer; originalname: string; size: number },
  ) {
    const task = await this.loadOwnedTask(userId, taskId);
    this.assertSettleable(task, 'attach a receipt to');

    if (file.size > this.config.maxReceiptBytes) {
      // multer's own limit normally rejects this first; this is the backstop for
      // a caller that reaches the service another way.
      throw new BadRequestException(
        `Receipt must be ${this.config.maxReceiptBytes} bytes or smaller.`,
      );
    }

    const mimeType = sniffMimeType(file.buffer);
    if (!mimeType) {
      throw new BadRequestException(
        'Receipt must be a JPEG, PNG, WebP, or PDF file.',
      );
    }

    const previous = await this.prisma.taskReceipt.findUnique({
      where: { taskId },
      select: { storageKey: true },
    });

    const stored = await this.storage.save(file.buffer, {
      mimeType,
      originalName: file.originalname,
      namespace: 'receipts',
    });

    const receiptData = {
      storageKey: stored.key,
      originalName: file.originalname,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      uploadedAt: new Date(),
    };

    // Upsert on the unique `taskId`, so a re-upload replaces rather than
    // colliding — the same idempotency shape the rest of this service uses.
    await this.prisma.taskReceipt.upsert({
      where: { taskId },
      create: { taskId, ...receiptData },
      update: receiptData,
    });

    if (previous) {
      await this.discardStoredFile(previous.storageKey);
    }

    return this.findOne(userId, Role.OFFICE_BOY, taskId);
  }

  /**
   * Opens the receipt for download. Readable by the owning office boy or any
   * admin — the admin needs it to book the expense, which is the whole point of
   * collecting it.
   *
   * Returns the stream plus the metadata the controller needs for its headers,
   * rather than touching the response itself, so the HTTP concerns stay in the
   * controller.
   */
  async getReceipt(
    userId: string,
    role: Role,
    taskId: string,
  ): Promise<{
    stream: Readable;
    mimeType: string;
    originalName: string;
    sizeBytes: number;
  }> {
    const receipt = await this.prisma.taskReceipt.findUnique({
      where: { taskId },
      select: {
        storageKey: true,
        mimeType: true,
        originalName: true,
        sizeBytes: true,
        task: { select: { officeBoyId: true } },
      },
    });

    if (!receipt) {
      throw new NotFoundException('This task has no receipt.');
    }

    if (role !== Role.ADMIN && receipt.task.officeBoyId !== userId) {
      throw new ForbiddenException('This task belongs to another office boy.');
    }

    return {
      stream: await this.storage.createReadStream(receipt.storageKey),
      mimeType: receipt.mimeType,
      originalName: receipt.originalName,
      sizeBytes: receipt.sizeBytes,
    };
  }

  /** Removes the receipt so a wrong photo can be replaced before submitting. */
  async deleteReceipt(userId: string, taskId: string) {
    const task = await this.loadOwnedTask(userId, taskId);
    this.assertSettleable(task, 'remove the receipt from');

    const receipt = await this.prisma.taskReceipt.findUnique({
      where: { taskId },
      select: { storageKey: true },
    });

    if (!receipt) {
      throw new NotFoundException('This task has no receipt.');
    }

    await this.prisma.taskReceipt.delete({ where: { taskId } });
    await this.discardStoredFile(receipt.storageKey);

    return { message: 'Receipt removed.' };
  }

  // --------------------------------------------------------------------------
  //  Internals
  // --------------------------------------------------------------------------
  /**
   * Loads the minimal task row needed for a state-changing action, and asserts
   * the caller owns it. Every mutating endpoint funnels through here so the
   * ownership check cannot be forgotten on one of them.
   *
   * Not-found and not-owner are distinct: a missing id is `404`, someone else's
   * task is `403`. Only office boys reach these endpoints (the controller's
   * `@Roles`), so there is no admin exception to make here.
   */
  private async loadOwnedTask(
    userId: string,
    taskId: string,
  ): Promise<TaskGuardRow> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        officeBoyId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        submittedAt: true,
      },
    });

    if (!task) {
      throw new NotFoundException('Task not found.');
    }

    if (task.officeBoyId !== userId) {
      throw new ForbiddenException('This task belongs to another office boy.');
    }

    return task;
  }

  /**
   * The shared precondition for every settlement action: the errand is finished,
   * and the paperwork has not been handed in yet.
   *
   * One method rather than the same two checks written out in three places, so
   * `settle`, `uploadReceipt` and `deleteReceipt` cannot drift apart on what
   * "still editable" means. `action` is spliced into the message so the office
   * boy is told which thing was refused, not just that something was.
   */
  private assertSettleable(task: TaskGuardRow, action: string): void {
    if (task.status !== TaskStatus.COMPLETED) {
      throw new ConflictException(
        `Cannot ${action} a task that is ${task.status}. End the task first.`,
      );
    }

    if (task.submittedAt !== null) {
      throw new ConflictException(
        `Cannot ${action} a task that has already been submitted.`,
      );
    }
  }

  /**
   * Best-effort removal of a stored file whose database row is already gone.
   *
   * Deliberately swallows failures: the authoritative record has been updated,
   * the caller's request succeeded, and turning "the janitor tripped" into a
   * 500 would report failure for an operation that worked. The leak is logged so
   * it can be swept up, rather than being invisible.
   */
  private async discardStoredFile(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `Orphaned receipt file left in storage: ${storageKey}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Asserts that `employeeId` refers to an existing, active employee.
   *
   * Used at task creation to keep the Top 10 link honest: a task must never
   * point at a deleted-in-spirit (deactivated) or non-existent employee. A
   * `findFirst` scoped to `isActive: true` collapses "does not exist" and
   * "no longer active" into one 400 — the caller does not need to distinguish
   * them, and doing so would leak which employee ids exist.
   */
  private async assertActiveEmployee(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, isActive: true },
      select: { id: true },
    });

    if (!employee) {
      throw new BadRequestException('Unknown or inactive employee.');
    }
  }

  /**
   * Re-runs the route computation from the current set of points and writes the
   * fresh totals back onto the task and its route. Used when late points arrive
   * for a task that has already been completed.
   *
   * Shares the exact `computeAndPersistRoute` pipeline that `end` uses, so the
   * recomputed numbers cannot drift from the originals by using different logic.
   */
  private async recomputeRoute(taskId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const computation = await this.computeAndPersistRoute(tx, taskId);
      await tx.task.update({
        where: { id: taskId },
        data: { distanceMeters: computation.distanceMeters },
      });
    });
  }

  /**
   * The shared core of `end` and `recomputeRoute`, run inside a caller's
   * transaction: read the raw trail, apply the noise filter, flag each point as
   * kept or filtered, and upsert the `Route` row. Returns the computation so the
   * caller can cache `distanceMeters` (and, on `end`, `durationSeconds`) onto
   * the task itself.
   *
   * Extracting it means the first computation and every recompute run
   * byte-identical logic — the only safe way to guarantee a recomputed distance
   * matches how it would have been computed the first time.
   */
  private async computeAndPersistRoute(
    tx: Pick<PrismaService, 'taskLocation' | 'route'>,
    taskId: string,
  ) {
    // Read the raw trail in recording order — the @@index([taskId, recordedAt])
    // makes this ordering free.
    const rawPoints = await tx.taskLocation.findMany({
      where: { taskId },
      orderBy: { recordedAt: 'asc' },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        accuracyMeters: true,
        isMoving: true,
      },
    });

    const computation = computeRoute<GeoPoint & { id: string }>(
      rawPoints,
      DEFAULT_ACCURACY_THRESHOLD_METERS,
    );

    // Persist the noise-filter verdict per point. We flag rather than delete, so
    // a corrected filter can recompute from the original data later.
    const filteredIds = computation.filtered.map((p) => p.id);
    const keptIds = computation.kept.map((p) => p.id);
    if (filteredIds.length > 0) {
      await tx.taskLocation.updateMany({
        where: { id: { in: filteredIds } },
        data: { isFiltered: true },
      });
    }
    if (keptIds.length > 0) {
      await tx.taskLocation.updateMany({
        where: { id: { in: keptIds } },
        data: { isFiltered: false },
      });
    }

    // One route row per task (Route.taskId is unique). Upsert so both the first
    // computation and every recompute reuse the same write.
    const routeData = {
      encodedPolyline: computation.encodedPolyline,
      distanceMeters: computation.distanceMeters,
      pointCount: computation.pointCount,
      rawPointCount: computation.rawPointCount,
    };
    await tx.route.upsert({
      where: { taskId },
      create: { taskId, ...routeData },
      update: routeData,
    });

    return computation;
  }
}
