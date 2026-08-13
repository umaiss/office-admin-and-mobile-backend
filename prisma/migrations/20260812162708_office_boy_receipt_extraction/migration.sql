-- AlterTable
ALTER TABLE "PettyCashLedgerEntry" ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewNote" TEXT;

-- AlterTable
ALTER TABLE "TaskReceipt" ADD COLUMN     "extractedAmount" DECIMAL(12,2),
ADD COLUMN     "extractedCategory" "PettyCashCategory",
ADD COLUMN     "extractedDate" DATE,
ADD COLUMN     "extractedDescription" TEXT,
ADD COLUMN     "extractedVendor" TEXT,
ADD COLUMN     "extractionConfidence" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "PettyCashLedgerEntry_needsReview_idx" ON "PettyCashLedgerEntry"("needsReview");
