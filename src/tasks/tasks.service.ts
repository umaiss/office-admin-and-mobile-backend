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
import { PettyCashService } from '../petty-cash/petty-cash.service';
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

type TaskRow = {
  amountReceived: unknown;
  amountReturned: unknown;
  [key: string]: unknown;
};

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

export const LATE_POINT_GRACE_MS = 10 * 60 * 1000;

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
    private readonly pettyCash: PettyCashService,
  ) {}

  async create(userId: string, dto: CreateTaskDto) {
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

  async findMany(userId: string, query: ListTasksQueryDto) {
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
      this.prisma.task.count({
        where: {
          officeBoyId: userId,
          status: TaskStatus.COMPLETED,
          submittedAt: null,
        },
      }),
    ]);

    const reimbursement = await this.rates.forOfficeBoy(userId);

    const counts: Record<TaskStatus, number> = {
      [TaskStatus.PENDING]: 0,
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.COMPLETED]: 0,
      [TaskStatus.CANCELLED]: 0,
    };
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

  async start(userId: string, taskId: string, dto: LocationPointDto) {
    const task = await this.loadOwnedTask(userId, taskId);

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
      skipDuplicates: true,
    });

    if (withinGrace && result.count > 0) {
      await this.recomputeRoute(taskId);
    }

    return { accepted: result.count, received: dto.points.length };
  }

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
        },
        select: TASK_SELECT,
      });
    });

    return toTaskResponse(updated);
  }

  async settle(userId: string, taskId: string, dto: SettlementDto) {
    const task = await this.loadOwnedTask(userId, taskId);
    this.assertSettleable(task, 'record the settlement for');

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        amountReceived: dto.amountReceived ?? 0,
        amountReturned: dto.amountReturned ?? 0,
        vendorDetails: dto.vendorDetails ? dto.vendorDetails : null,
      },
      select: TASK_SELECT,
    });

    return toTaskResponse(updated);
  }

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

    // Settlement fields aren't on TaskGuardRow (loadOwnedTask only selects the
    // state-machine columns) — fetch what createFromTask() needs separately.
    const settlement = await this.prisma.task.findUniqueOrThrow({
      where: { id: taskId },
      select: {
        description: true,
        vendorDetails: true,
        amountReceived: true,
        amountReturned: true,
        endedAt: true,
      },
    });

    const netAmount =
      Math.round(
        ((decimalToNumber(settlement.amountReceived as never) ?? 0) -
          (decimalToNumber(settlement.amountReturned as never) ?? 0)) *
          100,
      ) / 100;

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { submittedAt: new Date() },
      select: TASK_SELECT,
    });

    // Book the petty-cash entry only when money actually moved. A task
    // submitted with no settlement recorded (netAmount === 0) still submits
    // normally, but produces no ledger row — nothing there for an admin to
    // review or reconcile.
    //
    // NOTE: this write is NOT in the same transaction as the submittedAt
    // update above. If this throws — most likely because no petty cash
    // ledger is open for this task's endedAt month (see
    // PettyCashService.requireMonth, a deliberate fail-loud choice) — the
    // task is left submitted with its expense unbooked. That failure
    // propagates to the caller rather than being swallowed, so it's visible,
    // but it does mean the two records can end up out of sync until someone
    // retries or an admin opens the month. Making this fully atomic would
    // mean PettyCashService.createFromTask accepting an external Prisma
    // transaction client instead of opening its own — a larger refactor,
    // flagged here rather than made silently.
    if (netAmount > 0) {
      await this.pettyCash.createFromTask({
        taskId,
        officeBoyId: userId,
        amountSpent: netAmount,
        vendorDetails: settlement.vendorDetails ?? undefined,
        description: settlement.description,
        entryDate: settlement.endedAt ?? new Date(),
      });
    }

    return toTaskResponse(updated);
  }

  async cancel(userId: string, taskId: string, dto: CancelTaskDto) {
    const task = await this.loadOwnedTask(userId, taskId);

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
        cancelLatitude: dto.latitude,
        cancelLongitude: dto.longitude,
      },
      select: TASK_SELECT,
    });

    return toTaskResponse(updated);
  }

  async uploadReceipt(
    userId: string,
    taskId: string,
    file: { buffer: Buffer; originalname: string; size: number },
  ) {
    const task = await this.loadOwnedTask(userId, taskId);
    this.assertSettleable(task, 'attach a receipt to');

    if (file.size > this.config.maxReceiptBytes) {
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

  private async assertActiveEmployee(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, isActive: true },
      select: { id: true },
    });

    if (!employee) {
      throw new BadRequestException('Unknown or inactive employee.');
    }
  }

  private async recomputeRoute(taskId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const computation = await this.computeAndPersistRoute(tx, taskId);
      await tx.task.update({
        where: { id: taskId },
        data: { distanceMeters: computation.distanceMeters },
      });
    });
  }

  private async computeAndPersistRoute(
    tx: Pick<PrismaService, 'taskLocation' | 'route'>,
    taskId: string,
  ) {
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