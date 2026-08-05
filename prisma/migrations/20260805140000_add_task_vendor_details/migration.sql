-- ============================================================================
--  Vendor details on the task settlement
-- ============================================================================
--  One nullable column, so every existing row stays valid with no backfill.
--
--  NULL means "no vendor recorded", which is a real state — unlike the amounts
--  next to it, where an omitted value means zero and the column defaults to 0.
-- ============================================================================

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "vendorDetails" TEXT;
