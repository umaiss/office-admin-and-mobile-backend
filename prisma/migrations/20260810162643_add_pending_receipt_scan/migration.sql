-- CreateTable
CREATE TABLE "PendingReceiptScan" (
    "id" TEXT NOT NULL,
    "uploadToken" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "extractedAmount" DECIMAL(12,2),
    "extractedVendor" TEXT,
    "extractedDate" DATE,
    "extractedDescription" TEXT,
    "suggestedCategory" "PettyCashCategory",
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "uploadedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingReceiptScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingReceiptScan_uploadToken_key" ON "PendingReceiptScan"("uploadToken");

-- CreateIndex
CREATE INDEX "PendingReceiptScan_expiresAt_idx" ON "PendingReceiptScan"("expiresAt");

-- AddForeignKey
ALTER TABLE "PendingReceiptScan" ADD CONSTRAINT "PendingReceiptScan_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
