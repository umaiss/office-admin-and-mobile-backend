-- Adds a SHA-256 content hash to every table that stores a receipt file, so a
-- re-uploaded receipt can be recognised as the one already on file.
--
-- On PettyCashReceipt and TaskReceipt the column is NULLABLE: rows written
-- before this migration have no hash, and back-filling would mean re-reading
-- every stored file. Those receipts simply do not participate in duplicate
-- matching, which is the honest outcome — a null hash must never be treated as
-- "matches another null hash".

-- PendingReceiptScan takes a NOT NULL column, so any existing rows have to go
-- first. That is safe by design: a pending scan is an upload awaiting
-- confirmation, it self-expires after 30 minutes, and the only consequence of
-- dropping one is that the admin uploads the receipt again. Doing this
-- explicitly keeps the migration runnable against a live database instead of
-- only against an empty table.
DELETE FROM "PendingReceiptScan";

-- AlterTable
ALTER TABLE "PendingReceiptScan" ADD COLUMN     "contentHash" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "PettyCashReceipt" ADD COLUMN     "contentHash" TEXT;

-- AlterTable
ALTER TABLE "TaskReceipt" ADD COLUMN     "contentHash" TEXT;

-- CreateIndex
CREATE INDEX "PendingReceiptScan_contentHash_idx" ON "PendingReceiptScan"("contentHash");

-- CreateIndex
CREATE INDEX "PettyCashReceipt_contentHash_idx" ON "PettyCashReceipt"("contentHash");

-- CreateIndex
CREATE INDEX "TaskReceipt_contentHash_idx" ON "TaskReceipt"("contentHash");
