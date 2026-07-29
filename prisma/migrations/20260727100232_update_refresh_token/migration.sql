/*
  Warnings:

  - You are about to drop the column `token` on the `RefreshToken` table. All the data in the column will be lost.
  - You are about to drop the column `assignedToId` on the `Task` table. All the data in the column will be lost.
  - Added the required column `hashedToken` to the `RefreshToken` table without a default value. This is not possible if the table is not empty.
  - Added the required column `officeBoyId` to the `Task` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_assignedToId_fkey";

-- DropIndex
DROP INDEX "Task_assignedToId_idx";

-- AlterTable
ALTER TABLE "RefreshToken" DROP COLUMN "token",
ADD COLUMN     "hashedToken" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "assignedToId",
ADD COLUMN     "officeBoyId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Task_officeBoyId_idx" ON "Task"("officeBoyId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_officeBoyId_fkey" FOREIGN KEY ("officeBoyId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
