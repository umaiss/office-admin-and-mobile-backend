import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { callArg, firstArg } from '../common/testing/mock-args';
import { AppConfigService } from '../config/app-config.service';
import { Role, TaskStatus } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { ReimbursementRateService } from '../reimbursement/reimbursement-rate.service';
import { StorageService } from '../storage/storage.service';
import { EndTaskDto } from './dto/end-task.dto';
import { TasksService } from './tasks.service';

/**
 * These tests exercise the one thing the database cannot enforce for us: the
 * task state machine and the ownership rule. The schema guarantees a task has a
 * status, but not that a COMPLETED task refuses to be started again, nor that
 * one office boy cannot touch another's task. Those live in the service, so
 * that is what we pin down here.
 *
 * Prisma is fully mocked — no database, no clock dependence beyond `new Date()`,
 * which these assertions never inspect. Each test drives `findUnique` to return
 * a task in a chosen state and checks the branch the service takes.
 */
describe('TasksService', () => {
  let service: TasksService;
  let prisma: {
    task: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
      aggregate: jest.Mock;
    };
    employee: {
      findFirst: jest.Mock;
    };
    taskReceipt: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      delete: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let storage: {
    save: jest.Mock;
    createReadStream: jest.Mock;
    delete: jest.Mock;
    exists: jest.Mock;
  };
  let rates: { forOfficeBoy: jest.Mock };

  const OWNER_ID = 'owner-1';
  const OTHER_ID = 'someone-else';
  const TASK_ID = 'task-1';

  /** A minimal guard row as `loadOwnedTask`/`findOne` select it. */
  const guardRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: TASK_ID,
    officeBoyId: OWNER_ID,
    status: TaskStatus.PENDING,
    startedAt: null,
    endedAt: null,
    submittedAt: null,
    ...overrides,
  });

  /** A valid one-pixel-ish JPEG header, enough for the magic-byte sniff. */
  const jpegBuffer = () =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

  const uploadedFile = (buffer: Buffer = jpegBuffer()) => ({
    buffer,
    originalname: 'receipt.jpg',
    size: buffer.byteLength,
  });

  beforeEach(async () => {
    prisma = {
      task: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
        groupBy: jest.fn(),
        aggregate: jest.fn(),
      },
      employee: {
        findFirst: jest.fn(),
      },
      taskReceipt: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      // stats runs its aggregates inside one $transaction([...]) — resolve the
      // array of promises the service passes, mirroring Prisma's behaviour.
      $transaction: jest.fn((ops: unknown) =>
        Array.isArray(ops) ? Promise.all(ops as Promise<unknown>[]) : undefined,
      ),
    };

    storage = {
      save: jest.fn().mockResolvedValue({
        key: 'receipts/2026/08/generated.jpg',
        sizeBytes: 24,
        mimeType: 'image/jpeg',
      }),
      createReadStream: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(true),
    };

    rates = {
      forOfficeBoy: jest.fn().mockResolvedValue({
        officeBoyId: OWNER_ID,
        completedTasks: 0,
        totalDistanceMeters: 0,
        amount: 0,
        breakdown: [],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: ReimbursementRateService, useValue: rates },
        {
          provide: AppConfigService,
          useValue: { maxReceiptBytes: 5_242_880, reportTzOffsetMinutes: 0 },
        },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  // --------------------------------------------------------------------------
  //  Create is idempotent
  // --------------------------------------------------------------------------
  describe('create', () => {
    it('upserts on clientTaskId with a no-op update, so a retry never duplicates', async () => {
      prisma.task.upsert.mockResolvedValue({ id: TASK_ID });

      await service.create(OWNER_ID, {
        clientTaskId: 'client-uuid',
        title: 'Deliver documents',
        description: 'Take the folder to the bank.',
      });

      expect(prisma.task.upsert).toHaveBeenCalledTimes(1);
      const arg = firstArg(prisma.task.upsert);
      expect(arg.where).toEqual({ clientTaskId: 'client-uuid' });
      // A retry must not overwrite an in-flight task — the update is a no-op.
      expect(arg.update).toEqual({});
      // Identity comes from the token, never the body.
      expect(arg.create).toMatchObject({ officeBoyId: OWNER_ID });
    });

    it('accepts a description-only task, leaving title absent', async () => {
      prisma.task.upsert.mockResolvedValue({ id: TASK_ID });

      await service.create(OWNER_ID, {
        clientTaskId: 'client-uuid',
        description: 'Take the folder to the bank.',
      });

      const arg = firstArg(prisma.task.upsert);
      const create = arg.create as Record<string, unknown>;
      // In the field an OB creates with only a description; title is optional now.
      expect(create.title).toBeUndefined();
      expect(create).toMatchObject({
        description: 'Take the folder to the bank.',
        officeBoyId: OWNER_ID,
      });
    });

    // Top 10 employee link -----------------------------------------------------
    it('links an active Top 10 employee after checking it exists', async () => {
      prisma.employee.findFirst.mockResolvedValue({ id: 'emp-1' });
      prisma.task.upsert.mockResolvedValue({ id: TASK_ID });

      await service.create(OWNER_ID, {
        clientTaskId: 'client-uuid',
        description: 'Deliver to the top-10 employee.',
        employeeId: 'emp-1',
      });

      // The link is validated against an ACTIVE employee before persisting.
      expect(firstArg(prisma.employee.findFirst).where).toEqual({
        id: 'emp-1',
        isActive: true,
      });
      expect(firstArg(prisma.task.upsert).create).toMatchObject({
        employeeId: 'emp-1',
      });
    });

    it('rejects an unknown or inactive employee with 400 and never writes', async () => {
      // findFirst is scoped to isActive:true, so a missing OR deactivated
      // employee both surface as null here.
      prisma.employee.findFirst.mockResolvedValue(null);

      await expect(
        service.create(OWNER_ID, {
          clientTaskId: 'client-uuid',
          description: 'Deliver to a ghost.',
          employeeId: 'emp-gone',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.task.upsert).not.toHaveBeenCalled();
    });

    it('creates a task with no employee without touching the employee table', async () => {
      prisma.task.upsert.mockResolvedValue({ id: TASK_ID });

      await service.create(OWNER_ID, {
        clientTaskId: 'client-uuid',
        description: 'A plain errand.',
      });

      // No checkbox ticked → no employee lookup at all.
      expect(prisma.employee.findFirst).not.toHaveBeenCalled();
      expect(prisma.task.upsert).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  //  Start: only PENDING may start
  // --------------------------------------------------------------------------
  describe('start', () => {
    const fix = {
      latitude: 24.7,
      longitude: 46.6,
      recordedAt: '2026-07-31T08:00:00.000Z',
    };

    it('starts a PENDING task', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.PENDING }),
      );
      prisma.task.update.mockResolvedValue({
        id: TASK_ID,
        status: TaskStatus.IN_PROGRESS,
      });

      await service.start(OWNER_ID, TASK_ID, fix);

      expect(firstArg(prisma.task.update).data).toMatchObject({
        status: TaskStatus.IN_PROGRESS,
        startLatitude: 24.7,
        startLongitude: 46.6,
      });
    });

    it('rejects starting a COMPLETED task with 409', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );

      await expect(
        service.start(OWNER_ID, TASK_ID, fix as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  //  End: only IN_PROGRESS may end
  // --------------------------------------------------------------------------
  describe('end', () => {
    const fix = {
      latitude: 24.7,
      longitude: 46.6,
      recordedAt: '2026-07-31T09:00:00.000Z',
    };

    it('rejects ending a PENDING task with 409', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.PENDING }),
      );

      await expect(
        service.end(OWNER_ID, TASK_ID, fix as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('never touches the settlement columns — `settle` is their only writer', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.IN_PROGRESS, startedAt: new Date() }),
      );
      // `end` runs a callback transaction; hand it a tx stub with the pieces
      // computeAndPersistRoute and the final update need.
      const tx = {
        taskLocation: {
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn(),
        },
        route: { upsert: jest.fn() },
        task: {
          update: jest
            .fn()
            .mockResolvedValue({ amountReceived: 0, amountReturned: 0 }),
        },
      };
      prisma.$transaction.mockImplementation((fn: unknown) =>
        typeof fn === 'function'
          ? (fn as (t: unknown) => unknown)(tx)
          : Promise.all(fn as Promise<unknown>[]),
      );

      const result = await service.end(OWNER_ID, TASK_ID, fix);

      // Two routes writing these columns, with different meanings for an
      // omitted field, let a self-saving amounts screen silently zero what
      // `/end` had just stored. One writer removes that entirely.
      const data = firstArg(tx.task.update).data as Record<string, unknown>;
      expect(data).not.toHaveProperty('amountReceived');
      expect(data).not.toHaveProperty('amountReturned');
      // The task still completes with a settled, zeroed money picture.
      expect(result.netAmount).toBe(0);
    });

    it('rejects settlement amounts sent to /end rather than silently dropping them', async () => {
      // Mirrors the global pipe from main.ts. `forbidNonWhitelisted` is what
      // turns a client still sending the old shape into a loud 400, instead of
      // a task that quietly completes with 0 and an office boy who thinks the
      // money was recorded.
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      });

      await expect(
        pipe.transform(
          { ...fix, amountReceived: 500, amountReturned: 120 },
          { type: 'body', metatype: EndTaskDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The location fix on its own still validates.
      await expect(
        pipe.transform({ ...fix }, { type: 'body', metatype: EndTaskDto }),
      ).resolves.toMatchObject({ latitude: fix.latitude });
    });
  });

  // --------------------------------------------------------------------------
  //  Settlement: money, only on a completed-but-unsubmitted task
  // --------------------------------------------------------------------------
  describe('settle', () => {
    it('writes both amounts and the vendor on a COMPLETED, unsubmitted task', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );
      prisma.task.update.mockResolvedValue({
        amountReceived: 500,
        amountReturned: 120.5,
      });

      const result = await service.settle(OWNER_ID, TASK_ID, {
        amountReceived: 500,
        amountReturned: 120.5,
        vendorDetails: 'Al-Fatah Superstore, Gulberg — invoice #A-4471',
      });

      expect(firstArg(prisma.task.update).data).toEqual({
        amountReceived: 500,
        amountReturned: 120.5,
        vendorDetails: 'Al-Fatah Superstore, Gulberg — invoice #A-4471',
      });
      expect(result.netAmount).toBe(379.5);
    });

    it('resets every omitted field rather than leaving the old value', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );
      prisma.task.update.mockResolvedValue({
        amountReceived: 0,
        amountReturned: 0,
      });

      await service.settle(OWNER_ID, TASK_ID, {});

      // A PATCH of the settlement as a whole: clearing a box means zero (or, for
      // the vendor, nothing recorded) — not "keep what was there".
      expect(firstArg(prisma.task.update).data).toEqual({
        amountReceived: 0,
        amountReturned: 0,
        vendorDetails: null,
      });
    });

    it('stores an emptied vendor box as null, not as an empty string', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );
      prisma.task.update.mockResolvedValue({
        amountReceived: 0,
        amountReturned: 0,
      });

      await service.settle(OWNER_ID, TASK_ID, { vendorDetails: '' });

      // '' and "absent" are the same gesture from the office boy, so they must
      // not become two different states every reader has to handle.
      const data = firstArg(prisma.task.update).data as Record<string, unknown>;
      expect(data.vendorDetails).toBeNull();
    });

    it.each([TaskStatus.PENDING, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED])(
      'rejects settling a %s task with 409',
      async (status) => {
        prisma.task.findUnique.mockResolvedValue(guardRow({ status }));

        await expect(
          service.settle(OWNER_ID, TASK_ID, { amountReceived: 10 }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.task.update).not.toHaveBeenCalled();
      },
    );

    it('rejects settling an already-submitted task with 409', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED, submittedAt: new Date() }),
      );

      await expect(
        service.settle(OWNER_ID, TASK_ID, { amountReceived: 10 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  //  Submit: the terminal, non-idempotent step
  // --------------------------------------------------------------------------
  describe('submit', () => {
    it('stamps submittedAt on a COMPLETED task', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );
      prisma.task.update.mockResolvedValue({
        amountReceived: 0,
        amountReturned: 0,
      });

      await service.submit(OWNER_ID, TASK_ID);

      const data = firstArg(prisma.task.update).data as Record<string, unknown>;
      expect(data.submittedAt).toBeInstanceOf(Date);
    });

    it('does not require a receipt — the spec makes it optional', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );
      prisma.task.update.mockResolvedValue({
        amountReceived: 0,
        amountReturned: 0,
      });

      await expect(service.submit(OWNER_ID, TASK_ID)).resolves.toBeDefined();
      expect(prisma.taskReceipt.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a second submit with 409 rather than silently succeeding', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED, submittedAt: new Date() }),
      );

      await expect(service.submit(OWNER_ID, TASK_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('rejects submitting a task that was never completed', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.IN_PROGRESS }),
      );

      await expect(service.submit(OWNER_ID, TASK_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // --------------------------------------------------------------------------
  //  Receipts: the bytes decide the type, not the client
  // --------------------------------------------------------------------------
  describe('receipts', () => {
    beforeEach(() => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );
      prisma.taskReceipt.findUnique.mockResolvedValue(null);
      prisma.taskReceipt.upsert.mockResolvedValue({});
    });

    it('stores a real JPEG and records the SNIFFED type', async () => {
      await service.uploadReceipt(OWNER_ID, TASK_ID, uploadedFile());

      expect(storage.save).toHaveBeenCalledTimes(1);
      const options = callArg(storage.save, 0, 1);
      expect(options.mimeType).toBe('image/jpeg');
      expect(options.namespace).toBe('receipts');

      const create = firstArg(prisma.taskReceipt.upsert).create as Record<
        string,
        unknown
      >;
      expect(create.storageKey).toBe('receipts/2026/08/generated.jpg');
      // The client's filename is stored for display only — never as the key.
      expect(create.originalName).toBe('receipt.jpg');
      expect(create.storageKey).not.toContain('receipt.jpg');
    });

    it('rejects a file whose bytes are not an accepted image, however it is named', async () => {
      const disguised = {
        buffer: Buffer.from('<?php system($_GET["c"]); ?>          '),
        originalname: 'receipt.jpg',
        size: 38,
      };

      await expect(
        service.uploadReceipt(OWNER_ID, TASK_ID, disguised),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('rejects a file over the configured size limit', async () => {
      const huge = uploadedFile();
      huge.size = 6 * 1024 * 1024;

      await expect(
        service.uploadReceipt(OWNER_ID, TASK_ID, huge),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it('deletes the previous object when a receipt is replaced', async () => {
      prisma.taskReceipt.findUnique.mockResolvedValue({
        storageKey: 'receipts/2026/07/old.jpg',
      });

      await service.uploadReceipt(OWNER_ID, TASK_ID, uploadedFile());

      // Row first, then the unlink — so the database never points at a file
      // that has already gone.
      expect(prisma.taskReceipt.upsert).toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledWith('receipts/2026/07/old.jpg');
    });

    it('still succeeds when deleting the replaced object fails', async () => {
      prisma.taskReceipt.findUnique.mockResolvedValue({
        storageKey: 'receipts/2026/07/old.jpg',
      });
      storage.delete.mockRejectedValue(new Error('disk gone'));

      await expect(
        service.uploadReceipt(OWNER_ID, TASK_ID, uploadedFile()),
      ).resolves.toBeDefined();
    });

    it('refuses an upload once the task has been submitted', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED, submittedAt: new Date() }),
      );

      await expect(
        service.uploadReceipt(OWNER_ID, TASK_ID, uploadedFile()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("lets an admin download another office boy's receipt", async () => {
      prisma.taskReceipt.findUnique.mockResolvedValue({
        storageKey: 'receipts/2026/08/x.jpg',
        mimeType: 'image/jpeg',
        originalName: 'x.jpg',
        sizeBytes: 10,
        task: { officeBoyId: OTHER_ID },
      });
      storage.createReadStream.mockResolvedValue('stream');

      await expect(
        service.getReceipt(OWNER_ID, Role.ADMIN, TASK_ID),
      ).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    });

    it("refuses to let one office boy download another's receipt", async () => {
      prisma.taskReceipt.findUnique.mockResolvedValue({
        storageKey: 'receipts/2026/08/x.jpg',
        mimeType: 'image/jpeg',
        originalName: 'x.jpg',
        sizeBytes: 10,
        task: { officeBoyId: OTHER_ID },
      });

      await expect(
        service.getReceipt(OWNER_ID, Role.OFFICE_BOY, TASK_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.createReadStream).not.toHaveBeenCalled();
    });

    it('404s when the task has no receipt', async () => {
      prisma.taskReceipt.findUnique.mockResolvedValue(null);

      await expect(
        service.getReceipt(OWNER_ID, Role.OFFICE_BOY, TASK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  //  Cancel: terminal states cannot be cancelled
  // --------------------------------------------------------------------------
  describe('cancel', () => {
    const reason = { cancellationReason: 'Recipient unavailable.' };

    it('cancels an IN_PROGRESS task', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.IN_PROGRESS }),
      );
      prisma.task.update.mockResolvedValue({
        id: TASK_ID,
        status: TaskStatus.CANCELLED,
      });

      await service.cancel(OWNER_ID, TASK_ID, reason);

      expect(firstArg(prisma.task.update).data).toMatchObject({
        status: TaskStatus.CANCELLED,
      });
    });

    it('records the abandonment location when the office boy sends a fix', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.IN_PROGRESS }),
      );
      prisma.task.update.mockResolvedValue({ id: TASK_ID });

      await service.cancel(OWNER_ID, TASK_ID, {
        cancellationReason: 'Recipient unavailable.',
        latitude: 24.8607,
        longitude: 67.0011,
        recordedAt: '2026-07-31T09:00:00.000Z',
      });

      expect(firstArg(prisma.task.update).data).toMatchObject({
        status: TaskStatus.CANCELLED,
        cancellationReason: 'Recipient unavailable.',
        cancelLatitude: 24.8607,
        cancelLongitude: 67.0011,
      });
    });

    it('cancels with a reason only, leaving the location columns undefined', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.PENDING }),
      );
      prisma.task.update.mockResolvedValue({ id: TASK_ID });

      await service.cancel(OWNER_ID, TASK_ID, reason);

      const data = firstArg(prisma.task.update).data as Record<string, unknown>;
      // No signal → no fix sent. The columns stay unset rather than zeroed.
      expect(data.cancelLatitude).toBeUndefined();
      expect(data.cancelLongitude).toBeUndefined();
    });

    it('rejects cancelling a COMPLETED task with 409', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ status: TaskStatus.COMPLETED }),
      );

      await expect(
        service.cancel(OWNER_ID, TASK_ID, reason as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.task.update).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  //  Ownership + not-found
  // --------------------------------------------------------------------------
  describe('ownership', () => {
    const fix = {
      latitude: 24.7,
      longitude: 46.6,
      recordedAt: '2026-07-31T08:00:00.000Z',
    };

    it("denies acting on another office boy's task with 403", async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ officeBoyId: OTHER_ID, status: TaskStatus.PENDING }),
      );

      await expect(
        service.start(OWNER_ID, TASK_ID, fix as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing task', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.start(OWNER_ID, TASK_ID, fix as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  //  findOne access rule (owner or admin)
  // --------------------------------------------------------------------------
  describe('findOne', () => {
    it("lets an admin read another office boy's task", async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ officeBoyId: OTHER_ID }),
      );

      await expect(
        service.findOne(OWNER_ID, Role.ADMIN, TASK_ID),
      ).resolves.toMatchObject({
        id: TASK_ID,
      });
    });

    it('denies a non-owning office boy with 403', async () => {
      prisma.task.findUnique.mockResolvedValue(
        guardRow({ officeBoyId: OTHER_ID }),
      );

      await expect(
        service.findOne(OWNER_ID, Role.OFFICE_BOY, TASK_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 when the task does not exist', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.findOne(OWNER_ID, Role.OFFICE_BOY, TASK_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  //  stats: scoped to the caller, all four statuses present
  // --------------------------------------------------------------------------
  describe('stats', () => {
    it('scopes every aggregate to the caller and fills absent statuses with 0', async () => {
      prisma.task.groupBy.mockResolvedValue([
        { status: TaskStatus.COMPLETED, _count: { _all: 3 } },
      ]);
      prisma.task.count
        .mockResolvedValueOnce(5) // total
        .mockResolvedValueOnce(2); // completedToday
      prisma.task.aggregate.mockResolvedValue({
        _sum: { distanceMeters: 1200, durationSeconds: 3600 },
      });

      const result = await service.stats(OWNER_ID);

      // Identity comes from the token: every query is hard-scoped to OWNER_ID.
      expect(firstArg(prisma.task.groupBy).where).toEqual({
        officeBoyId: OWNER_ID,
      });
      const countCalls = prisma.task.count.mock.calls as unknown[][];
      expect((countCalls[0][0] as Record<string, any>).where).toMatchObject({
        officeBoyId: OWNER_ID,
      });

      expect(result).toMatchObject({
        tasks: {
          total: 5,
          [TaskStatus.PENDING]: 0,
          [TaskStatus.IN_PROGRESS]: 0,
          [TaskStatus.COMPLETED]: 3,
          [TaskStatus.CANCELLED]: 0,
        },
        completedToday: 2,
        totalDistanceMeters: 1200,
        totalDurationSeconds: 3600,
      });
    });

    it('defaults null aggregate sums to 0', async () => {
      prisma.task.groupBy.mockResolvedValue([]);
      prisma.task.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      prisma.task.aggregate.mockResolvedValue({
        _sum: { distanceMeters: null, durationSeconds: null },
      });

      const result = await service.stats(OWNER_ID);

      expect(result.totalDistanceMeters).toBe(0);
      expect(result.totalDurationSeconds).toBe(0);
    });
  });
});
