-- ============================================================================
--  Phase 1 — tracking domain
-- ============================================================================
--  Safe to apply to the existing development database: at the time this was
--  generated, Task, TaskLocation, Notification and Route held zero rows, so
--  the DROP COLUMN and ADD COLUMN ... NOT NULL statements below destroy no
--  data. The only change to the populated User table is an additive,
--  nullable `lastLoginAt`.
--
--  Summary of changes:
--    • New models: Route, Attendance
--    • Offline-sync idempotency keys: Task.clientTaskId, TaskLocation.clientId
--    • Device vs server time split: TaskLocation.recordedAt / .receivedAt
--    • Units in names: distance -> distanceMeters, duration -> durationSeconds
--    • Cascade deletes on child rows (locations, notifications, tokens)
--    • Composite indexes matching the queries Phases 3-8 will actually run
--    • Dropped the redundant User(email) index — @unique already indexes it
-- ============================================================================

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'HALF_DAY');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TASK_STARTED', 'TASK_COMPLETED', 'TASK_CANCELLED', 'ATTENDANCE_CHECK_IN', 'ATTENDANCE_CHECK_OUT', 'SYSTEM');

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_userId_fkey";

-- DropForeignKey
ALTER TABLE "RefreshToken" DROP CONSTRAINT "RefreshToken_userId_fkey";

-- DropForeignKey
ALTER TABLE "TaskLocation" DROP CONSTRAINT "TaskLocation_taskId_fkey";

-- DropIndex
DROP INDEX "Notification_userId_idx";

-- DropIndex
DROP INDEX "Task_officeBoyId_idx";

-- DropIndex
DROP INDEX "Task_status_idx";

-- DropIndex
DROP INDEX "TaskLocation_recordedAt_idx";

-- DropIndex
DROP INDEX "TaskLocation_taskId_idx";

-- DropIndex
DROP INDEX "User_email_idx";

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "taskId" TEXT,
ADD COLUMN     "type" "NotificationType" NOT NULL;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "replacedByTokenId" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "distance",
DROP COLUMN "duration",
DROP COLUMN "endTime",
DROP COLUMN "startTime",
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "clientTaskId" TEXT,
ADD COLUMN     "distanceMeters" DOUBLE PRECISION,
ADD COLUMN     "durationSeconds" INTEGER,
ADD COLUMN     "endLatitude" DOUBLE PRECISION,
ADD COLUMN     "endLongitude" DOUBLE PRECISION,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "startLatitude" DOUBLE PRECISION,
ADD COLUMN     "startLongitude" DOUBLE PRECISION,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TaskLocation" DROP COLUMN "accuracy",
ADD COLUMN     "accuracyMeters" DOUBLE PRECISION,
ADD COLUMN     "altitudeMeters" DOUBLE PRECISION,
ADD COLUMN     "batteryLevel" INTEGER,
ADD COLUMN     "clientId" TEXT NOT NULL,
ADD COLUMN     "headingDegrees" DOUBLE PRECISION,
ADD COLUMN     "isFiltered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isMoving" BOOLEAN,
ADD COLUMN     "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "speedMetersPerSecond" DOUBLE PRECISION,
ALTER COLUMN "recordedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Route" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "encodedPolyline" TEXT NOT NULL,
    "distanceMeters" DOUBLE PRECISION NOT NULL,
    "pointCount" INTEGER NOT NULL,
    "rawPointCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "checkInAt" TIMESTAMP(3),
    "checkOutAt" TIMESTAMP(3),
    "checkInLatitude" DOUBLE PRECISION,
    "checkInLongitude" DOUBLE PRECISION,
    "checkOutLatitude" DOUBLE PRECISION,
    "checkOutLongitude" DOUBLE PRECISION,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'ABSENT',
    "workedSeconds" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Route_taskId_key" ON "Route"("taskId");

-- CreateIndex
CREATE INDEX "Attendance_date_idx" ON "Attendance"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_date_key" ON "Attendance"("userId", "date");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_clientTaskId_key" ON "Task"("clientTaskId");

-- CreateIndex
CREATE INDEX "Task_officeBoyId_status_idx" ON "Task"("officeBoyId", "status");

-- CreateIndex
CREATE INDEX "Task_officeBoyId_createdAt_idx" ON "Task"("officeBoyId", "createdAt");

-- CreateIndex
CREATE INDEX "Task_status_createdAt_idx" ON "Task"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaskLocation_clientId_key" ON "TaskLocation"("clientId");

-- CreateIndex
CREATE INDEX "TaskLocation_taskId_recordedAt_idx" ON "TaskLocation"("taskId", "recordedAt");

-- CreateIndex
CREATE INDEX "TaskLocation_receivedAt_idx" ON "TaskLocation"("receivedAt");

-- CreateIndex
CREATE INDEX "User_role_isActive_idx" ON "User"("role", "isActive");

-- AddForeignKey
ALTER TABLE "TaskLocation" ADD CONSTRAINT "TaskLocation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
