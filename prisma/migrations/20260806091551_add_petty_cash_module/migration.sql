/*
  Warnings:

  - You are about to drop the column `amountReceived` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `amountReturned` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `employeeId` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `submittedAt` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `vendorDetails` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the `Employee` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ReimbursementRate` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TaskReceipt` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `title` on table `Task` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "ReimbursementRate" DROP CONSTRAINT "ReimbursementRate_createdById_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_employeeId_fkey";

-- DropForeignKey
ALTER TABLE "TaskReceipt" DROP CONSTRAINT "TaskReceipt_taskId_fkey";

-- DropIndex
DROP INDEX "Task_employeeId_status_idx";

-- DropIndex
DROP INDEX "Task_status_endedAt_idx";

-- DropIndex
DROP INDEX "Task_submittedAt_idx";

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "amountReceived",
DROP COLUMN "amountReturned",
DROP COLUMN "employeeId",
DROP COLUMN "submittedAt",
DROP COLUMN "vendorDetails",
ADD COLUMN     "fuelCost" DOUBLE PRECISION,
ALTER COLUMN "title" SET NOT NULL;

-- DropTable
DROP TABLE "Employee";

-- DropTable
DROP TABLE "ReimbursementRate";

-- DropTable
DROP TABLE "TaskReceipt";

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "fuelRatePerKm" DOUBLE PRECISION NOT NULL DEFAULT 11,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);
