/*
  Warnings:

  - You are about to drop the column `fuelCost` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the `AppSetting` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "LedgerEntrySource" AS ENUM ('TASK', 'MANUAL');

-- CreateEnum
CREATE TYPE "PettyCashCategory" AS ENUM ('TRANSPORT', 'FUEL', 'OFFICE_SUPPLIES', 'COURIER', 'MAINTENANCE_REPAIRS', 'UTILITIES', 'MEALS_REFRESHMENTS', 'PRINTING_STATIONERY', 'GUEST_HOSPITALITY', 'MISCELLANEOUS', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('PETTY_CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "OpeningBalanceSource" AS ENUM ('CARRY_FORWARD', 'MANUAL');

-- CreateEnum
CREATE TYPE "AdjustmentType" AS ENUM ('TOP_UP', 'CORRECTION');

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "fuelCost",
ADD COLUMN     "amountReceived" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amountReturned" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "employeeId" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "vendorDetails" TEXT,
ALTER COLUMN "title" DROP NOT NULL;

-- DropTable
DROP TABLE "AppSetting";

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

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashMonthlyLedger" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "openingBalance" DECIMAL(12,2) NOT NULL,
    "openingBalanceSource" "OpeningBalanceSource" NOT NULL,
    "totalExpenses" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "remainingBalance" DECIMAL(12,2) NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "setById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PettyCashMonthlyLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashLedgerEntry" (
    "id" TEXT NOT NULL,
    "monthlyLedgerId" TEXT NOT NULL,
    "source" "LedgerEntrySource" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "category" "PettyCashCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "supplier" TEXT,
    "entryDate" DATE NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'PETTY_CASH',
    "staffId" TEXT,
    "taskId" TEXT,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PettyCashLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashBalanceAdjustment" (
    "id" TEXT NOT NULL,
    "monthlyLedgerId" TEXT NOT NULL,
    "type" "AdjustmentType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PettyCashBalanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashReceipt" (
    "id" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "extractedAmount" DECIMAL(12,2),
    "extractedVendor" TEXT,
    "extractedDate" DATE,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PettyCashReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaskReceipt_taskId_key" ON "TaskReceipt"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementRate_effectiveFrom_key" ON "ReimbursementRate"("effectiveFrom");

-- CreateIndex
CREATE INDEX "Employee_isActive_idx" ON "Employee"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashMonthlyLedger_year_month_key" ON "PettyCashMonthlyLedger"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashLedgerEntry_taskId_key" ON "PettyCashLedgerEntry"("taskId");

-- CreateIndex
CREATE INDEX "PettyCashLedgerEntry_monthlyLedgerId_entryDate_idx" ON "PettyCashLedgerEntry"("monthlyLedgerId", "entryDate");

-- CreateIndex
CREATE INDEX "PettyCashLedgerEntry_monthlyLedgerId_source_idx" ON "PettyCashLedgerEntry"("monthlyLedgerId", "source");

-- CreateIndex
CREATE INDEX "PettyCashLedgerEntry_monthlyLedgerId_category_idx" ON "PettyCashLedgerEntry"("monthlyLedgerId", "category");

-- CreateIndex
CREATE INDEX "PettyCashLedgerEntry_staffId_idx" ON "PettyCashLedgerEntry"("staffId");

-- CreateIndex
CREATE INDEX "PettyCashBalanceAdjustment_monthlyLedgerId_createdAt_idx" ON "PettyCashBalanceAdjustment"("monthlyLedgerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashReceipt_ledgerEntryId_key" ON "PettyCashReceipt"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "Task_employeeId_status_idx" ON "Task"("employeeId", "status");

-- CreateIndex
CREATE INDEX "Task_status_endedAt_idx" ON "Task"("status", "endedAt");

-- CreateIndex
CREATE INDEX "Task_submittedAt_idx" ON "Task"("submittedAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReceipt" ADD CONSTRAINT "TaskReceipt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementRate" ADD CONSTRAINT "ReimbursementRate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashMonthlyLedger" ADD CONSTRAINT "PettyCashMonthlyLedger_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashLedgerEntry" ADD CONSTRAINT "PettyCashLedgerEntry_monthlyLedgerId_fkey" FOREIGN KEY ("monthlyLedgerId") REFERENCES "PettyCashMonthlyLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashLedgerEntry" ADD CONSTRAINT "PettyCashLedgerEntry_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashLedgerEntry" ADD CONSTRAINT "PettyCashLedgerEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashLedgerEntry" ADD CONSTRAINT "PettyCashLedgerEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashBalanceAdjustment" ADD CONSTRAINT "PettyCashBalanceAdjustment_monthlyLedgerId_fkey" FOREIGN KEY ("monthlyLedgerId") REFERENCES "PettyCashMonthlyLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashBalanceAdjustment" ADD CONSTRAINT "PettyCashBalanceAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashReceipt" ADD CONSTRAINT "PettyCashReceipt_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "PettyCashLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
