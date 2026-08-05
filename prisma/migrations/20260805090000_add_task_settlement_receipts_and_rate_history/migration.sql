-- ============================================================================
--  Task settlement, receipts, and effective-dated reimbursement rates
-- ============================================================================
--  Additive only. Every new Task column has a default or is nullable, so
--  existing rows remain valid and no backfill is needed:
--    * amountReceived / amountReturned default to 0 — an office boy who entered
--      nothing settled nothing, which is exactly what the spec says.
--    * submittedAt is NULL for every historical task, meaning "not handed in".
--
--  The one data statement is the genesis reimbursement rate. See below.
-- ============================================================================

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "amountReceived" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amountReturned" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TaskReceipt" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementRate" (
    "id" TEXT NOT NULL,
    "ratePerKm" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReimbursementRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskReceipt_taskId_key" ON "TaskReceipt"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementRate_effectiveFrom_key" ON "ReimbursementRate"("effectiveFrom");

-- CreateIndex
CREATE INDEX "ReimbursementRate_effectiveFrom_idx" ON "ReimbursementRate"("effectiveFrom");

-- CreateIndex
CREATE INDEX "Task_status_endedAt_idx" ON "Task"("status", "endedAt");

-- CreateIndex
CREATE INDEX "Task_submittedAt_idx" ON "Task"("submittedAt");

-- AddForeignKey
ALTER TABLE "TaskReceipt" ADD CONSTRAINT "TaskReceipt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementRate" ADD CONSTRAINT "ReimbursementRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
--  Genesis rate
-- ----------------------------------------------------------------------------
--  A rate applies to `[effectiveFrom, <next rate's effectiveFrom>)`. Without a
--  row starting at the beginning of time, every task completed before the first
--  rate an admin happens to enter would fall outside all periods and could not
--  be priced at all. Seeding the epoch closes that hole permanently.
--
--  The value is 25/km — what the hardcoded `REIMBURSEMENT_RATE_PER_KM` constant
--  this table replaces was set to, so existing reports do not change value.
--
--  ON CONFLICT DO NOTHING makes this safe to re-run and safe on a database that
--  already has it.
INSERT INTO "ReimbursementRate" ("id", "ratePerKm", "effectiveFrom", "note", "createdAt")
VALUES (
    '00000000-0000-4000-8000-000000000001',
    25,
    TIMESTAMP '1970-01-01 00:00:00',
    'Initial rate, carried over from the previous hardcoded value.',
    CURRENT_TIMESTAMP
)
ON CONFLICT ("effectiveFrom") DO NOTHING;
