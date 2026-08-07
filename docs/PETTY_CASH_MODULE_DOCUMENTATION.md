# Petty Cash Module — Technical Documentation

## 1. Architecture Overview

The petty cash module is a self-contained NestJS module (`PettyCashModule`) added
alongside the existing `TaskModule`, `UserModule`, etc. It owns four new database
tables and does not modify the ownership of any existing table — it only adds an
optional inverse relation on `Task` and `User`.

```
                     ┌────────────────────┐
   Office Boy app ──▶│   TaskController    │──▶ Task.submit()
                     └─────────┬──────────┘        │
                               │ calls              │ on success
                               ▼                    ▼
                     ┌────────────────────┐   PettyCashService
                     │   PettyCashModule   │   .createFromTask()
                     │  (this deliverable) │
                     └─────────┬──────────┘
                               │
   Admin panel ────────────────┤
   (manual entry, scan          │
   receipt, adjustments,        ▼
   month open/close)   PostgreSQL: PettyCashMonthlyLedger,
                        PettyCashLedgerEntry,
                        PettyCashBalanceAdjustment,
                        PettyCashReceipt
```

Two entry points create ledger rows:
1. **Task settlement** — internal, service-to-service call from `TaskModule`.
   Not an HTTP endpoint of this module.
2. **Admin actions** — HTTP endpoints: manual entry, scan-receipt confirm,
   edit, delete, adjustments, month open.

## 2. Recommended Folder Structure

```
src/
  petty-cash/
    dto/
      create-manual-entry.dto.ts
      confirm-scan-entry.dto.ts
      update-entry.dto.ts
      query-ledger.dto.ts
      set-opening-balance.dto.ts
      create-adjustment.dto.ts
      ledger-response.dto.ts
      scan-extraction-response.dto.ts
      index.ts
    petty-cash.constants.ts     # enums shared by DTOs
    petty-cash.controller.ts
    petty-cash.service.ts
    petty-cash.module.ts
  prisma/
    prisma.service.ts           # assumed to already exist
    prisma.module.ts
  storage/
    storage.service.ts          # assumed to already exist (used by TaskReceipt today)
    storage.module.ts
  auth/
    jwt-auth.guard.ts           # assumed to already exist
    roles.guard.ts
    roles.decorator.ts
    current-user.decorator.ts
```

This deliverable assumes `PrismaService`, `StorageService`, and the auth guards
already exist in your codebase (the existing schema's comments reference all
three — `StorageService` explicitly, and JWT auth via `RefreshToken`/`User`).
Their exact contracts were confirmed against the real implementations during
integration (see `petty-cash.service.ts`'s `getReceiptStream()` for
`StorageService`, and the `../generated/prisma/client` import for
`PrismaService`'s underlying Prisma client) — so unlike a from-scratch guess,
these are wired to match what actually exists, not an assumed shape.

## 3. Database Relationships

```
User ──< PettyCashMonthlyLedger.setBy (SetNull)
User ──< PettyCashLedgerEntry.staff (SetNull, optional)
User ──< PettyCashLedgerEntry.createdBy (Restrict, required)
User ──< PettyCashBalanceAdjustment.createdBy (Restrict, required)

PettyCashMonthlyLedger ──< PettyCashLedgerEntry (Restrict)
PettyCashMonthlyLedger ──< PettyCashBalanceAdjustment (Restrict)

Task ──1:1── PettyCashLedgerEntry (Restrict, optional — only for source=TASK)
PettyCashLedgerEntry ──1:1── PettyCashReceipt (Cascade, optional)
```

`Restrict` is used everywhere a ledger row points at something that must never
silently vanish from underneath a financial record (a month, a task, the user
who entered it). `SetNull` is used only for "who touched this" audit fields
where losing the link is acceptable but losing the row is not — consistent
with how the existing schema treats `ReimbursementRate.createdBy`.

## 4. Prisma Schema Explanation

See `prisma/schema-additions.prisma` for the full schema with inline reasoning
on every field. Summary of the four new tables:

| Table | Purpose |
|---|---|
| `PettyCashMonthlyLedger` | One row per calendar month; holds the opening balance and cached totals that back the dashboard KPI cards. |
| `PettyCashLedgerEntry` | One row per expense — either TASK-derived or MANUAL. This is the ledger table's data source. |
| `PettyCashBalanceAdjustment` | Non-expense balance movements (top-ups, corrections), kept separate so "Total Expenses" is never polluted. |
| `PettyCashReceipt` | Metadata + storage pointer for receipts attached to MANUAL entries (including scanned ones). TASK entries reuse the existing `TaskReceipt`. |

**Category as enum, not a table**: chosen because the dropdown is small and
admin-curated in code today. If the Admin Department later wants to add
categories without a deploy, promote `PettyCashCategory` to its own table —
see Recommendations (§11).

## 5. Business Logic

### 5.1 Task Lifecycle (existing, unchanged) → Petty Cash Handoff

The existing `Task` model already carries `amountReceived`, `amountReturned`,
`vendorDetails`, and `submittedAt`. This module does not change that flow — it
adds a single hook:

1. Office boy starts a task → `Task.startedAt` set.
2. Office boy ends the task → `Task.endedAt` set, distance/duration cached.
3. Office boy fills the settlement form (amount spent, receipt, remarks) and
   hits submit → `POST /tasks/:id/submit` in the **existing** `TaskModule`.
4. Inside that handler, `Task.submittedAt` is set, then — if the settlement
   has a non-zero net amount — `TaskModule` calls:

   ```ts
   const netAmount = amountReceived - amountReturned; // rounded to 2dp

   if (netAmount > 0) {
     await this.pettyCash.createFromTask({
       taskId: task.id,
       officeBoyId: task.officeBoyId,
       amountSpent: netAmount,
       vendorDetails: task.vendorDetails ?? undefined,
       description: task.description,
       entryDate: task.endedAt ?? new Date(),
     });
   }
   ```

   A task settled with `netAmount === 0` (nothing spent — a purely
   informational errand) still submits normally but creates no ledger row;
   there'd be nothing on it for an admin to review.

5. This creates a `PettyCashLedgerEntry` with `source = TASK`, linked 1:1 to
   the task, in whichever month's ledger `task.endedAt` falls into.

**Important — this is two separate writes, not one transaction.** The
`Task.submittedAt` update and the `PettyCashLedgerEntry` creation are not
wrapped in a shared Prisma transaction. If step 4 throws — most commonly
because the target month's ledger hasn't been opened yet (see below) — the
task is left submitted with its expense unbooked, and the failure propagates
back to the office boy's client rather than being swallowed. Making this
fully atomic would require `PettyCashService.createFromTask()` to accept an
external transaction client instead of opening its own; that's a reasonable
follow-up (see Recommendations, §11) but wasn't done as part of this
deliverable.

If that month's ledger hasn't been opened yet, `createFromTask` throws — the
task remains submitted (financially settled from the office boy's point of
view) but the admin must open the month, then re-trigger the booking, before
it appears on the dashboard. This is a deliberate fail-loud choice over
silently creating a month with a zero opening balance — see Assumptions
(§10).

### 5.2 Petty Cash Lifecycle

```
Admin opens month (carry-forward or manual)
        │
        ▼
Entries accumulate all month
 (TASK auto-entries + MANUAL entries)
        │
        ▼
Admin optionally records adjustments
 (top-ups / corrections)
        │
        ▼
Month-end: Admin opens NEXT month
 → previous month auto-closes
 → previous month's remainingBalance
   becomes next month's openingBalance
   (if carry-forward was chosen)
```

A closed month is **not read-only** — an admin can still edit/delete entries
in it after month-end (corrections happen after the fact regularly in real
office accounting). `isClosed` only blocks new **TASK**-sourced auto-entries,
because an office boy settling a task against a month that's already been
carried forward would corrupt the carry-forward amount that the next month
already opened with.

### 5.3 Manual Entry Workflow

Two admin-initiated paths, both ending at the same `PettyCashLedgerEntry`
table with `source = MANUAL`:

- **Direct manual entry** (Image 2): single `POST /petty-cash/entries` call.
- **Scan receipt** (Image 3): two calls —
  1. `POST /petty-cash/entries/scan/extract` (multipart) — uploads the file,
     returns OCR suggestions + an `uploadToken`.
  2. `POST /petty-cash/entries/scan/confirm?uploadToken=...` — admin-confirmed
     fields, creates the entry and attaches the receipt.

The two-call split exists because the UI itself is two screens (upload →
confirm), and because it lets the admin abandon a bad scan without ever
creating a ledger row.

## 6. Balance Calculation Logic

Three distinct numbers, calculated three different ways — this distinction
matters and is easy to get wrong:

| Number | Where it lives | When it's computed |
|---|---|---|
| `PettyCashMonthlyLedger.totalExpenses` | Cached column | Recomputed transactionally on every entry/adjustment write for that month (`recomputeLedgerTotals`) |
| `PettyCashMonthlyLedger.remainingBalance` | Cached column | Same as above: `openingBalance + Σadjustments(signed) − totalExpenses` |
| Per-entry `runningBalance` | **Never persisted** | Computed at read time in `listEntries()`, folding entries oldest-first within their month |

**Why cache the month-level totals but never the per-entry running balance?**
The month totals change only when a row is added/edited/deleted *in that
specific month* — a cheap, well-scoped recompute. A per-entry running balance
changes for every entry *after* the edited one, every time any entry is
backdated or corrected — an unbounded cascade for what is otherwise a routine
admin correction. Computing it at read time costs one extra query over a
month's entries (typically dozens, not thousands) and can never drift.

`totalEntries` on the summary DTO is a live `count()` — cheap, and caching a
plain count buys nothing a count() doesn't already give you instantly.

## 7. Monthly Reset Process

There is no scheduled job. The reset is admin-triggered by calling
`POST /petty-cash/months` for the new month:

- **Carry forward** (typical case): omit `amount`. The service finds
  `year/month - 1`, reads its current `remainingBalance`, uses that as the new
  month's `openingBalance`, and marks the previous month `isClosed = true`.
- **Manual override**: supply `amount`. The new month opens with exactly that
  value, `openingBalanceSource = MANUAL`, and the previous month is **not**
  auto-closed (an admin might set next month's balance before finishing this
  month's paperwork — closing is a carry-forward side effect only).

If no previous month exists at all (first month the system is used) and no
`amount` is supplied, the call fails with a 400 telling the admin to supply
one — there's nothing to carry forward from.

## 8. API Documentation

Full request/response schemas, validation rules, and examples are in the
Swagger decorators throughout `petty-cash.controller.ts` and the `dto/`
files — they render automatically at `/api` (or wherever `SwaggerModule` is
mounted) once this module is registered. Endpoint summary:

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/petty-cash/months` | Admin | Open a month (carry-forward or manual) |
| GET | `/petty-cash/months/:year/:month/summary` | Admin | Dashboard KPI cards |
| POST | `/petty-cash/months/:year/:month/adjustments` | Admin | Top-up / correction |
| GET | `/petty-cash/entries` | Admin | Ledger table, filtered/paginated |
| GET | `/petty-cash/entries/:id/receipt` | Admin | Stream a ledger entry's receipt file |
| POST | `/petty-cash/entries` | Admin | Manual entry |
| POST | `/petty-cash/entries/scan/extract` | Admin | Upload receipt, get OCR suggestions |
| POST | `/petty-cash/entries/scan/confirm` | Admin | Confirm scan, create entry |
| PATCH | `/petty-cash/entries/:id` | Admin | Edit an entry |
| DELETE | `/petty-cash/entries/:id` | Admin | Delete an entry |

`PettyCashService.createFromTask()` is intentionally **not** an HTTP endpoint
— it's called in-process by `TaskModule`.

### Receipt downloads

`StorageService` is stream-based (`createReadStream`), not signed-URL-based
— there's no `getSignedUrl()`-style method to hand a client a direct link.
So the `receipt.url` field on every ledger entry response is not a link to
the storage provider; it's the path to this module's own endpoint:
`GET /petty-cash/entries/:id/receipt`, which resolves whichever receipt
actually belongs to the entry (a MANUAL entry's own `PettyCashReceipt`, or a
TASK entry's `TaskReceipt` via the linked task) and pipes the file straight
through as a `StreamableFile`, with `Content-Type` and `Content-Disposition`
set from the stored metadata.

### Example: create manual entry

**Request** — `POST /petty-cash/entries`
```json
{
  "amount": 2145.50,
  "category": "OFFICE_SUPPLIES",
  "description": "Printer ink cartridges and A4 paper restock",
  "supplier": "Office Depot",
  "entryDate": "2026-10-24",
  "paymentMethod": "PETTY_CASH",
  "notes": "Urgent restock, approved verbally by Farid"
}
```

**Response — 201**
```json
{
  "id": "e2a1c9f4-...",
  "source": "MANUAL",
  "amount": 2145.50,
  "category": "OFFICE_SUPPLIES",
  "description": "Printer ink cartridges and A4 paper restock",
  "supplier": "Office Depot",
  "entryDate": "2026-10-24",
  "month": "October",
  "paymentMethod": "PETTY_CASH",
  "runningBalance": 2854.50,
  "createdBy": { "id": "8f2b...", "name": "Sarah J." },
  "createdAt": "2026-10-24T09:12:00.000Z"
}
```

**Error — 400** (no month open)
```json
{
  "statusCode": 400,
  "message": "No petty cash ledger open for 2026-10. An admin must open it first (carry-forward or manual opening balance).",
  "error": "Bad Request"
}
```

## 9. Data Flow Summary

```
Office Boy task submit ─▶ TaskModule.submit() ─▶ PettyCashService.createFromTask()
                                                          │
Admin manual entry     ─▶ PettyCashController ──────────▶│──▶ recomputeLedgerTotals()
Admin scan receipt     ─▶ PettyCashController ──────────▶│         │
Admin adjustment       ─▶ PettyCashController ──────────▶┘         ▼
                                                        PettyCashMonthlyLedger
                                                        (totalExpenses, remainingBalance)
                                                                    │
                                                                    ▼
                                                      GET /months/:y/:m/summary
                                                      → Dashboard KPI cards
```

## 10. Assumptions Made

1. **`PrismaService`, `StorageService`, `JwtAuthGuard`, `RolesGuard` already
   exist** in the codebase, matching the patterns implied by the existing
   schema's comments (`StorageService` is referenced directly in
   `TaskReceipt`'s doc comment).
2. **Task-derived entries have no category input** in the office boy's
   settlement form (not shown in any of the three screens), so
   `createFromTask()` defaults to `MISCELLANEOUS`. The admin recategorises
   from the ledger table if needed — this matches "Admin can edit any entry".
3. **"Total Owed to Staff" is out of scope**, per your instruction — the KPI
   card exists in the dashboard screenshot but is not implemented here.
4. **OCR/receipt-scanning extraction is stubbed** (`runOcrStub`) — plugging in
   an actual vision/OCR provider is an infrastructure decision outside a
   ledger data model's scope. The confirm step doesn't depend on OCR success;
   an admin can always fill fields manually.
5. **`entryDate` (not `createdAt`) determines which month an entry belongs
   to.** An admin backdating an entry into last month is expected and
   supported (as long as that month's ledger is still open or an admin
   deliberately edits a closed month).
6. **Pending scan uploads are held in an in-process `Map`** with a 30-minute
   TTL rather than in the database or Redis — see Recommendations (§11) for
   why this needs to change before horizontal scaling.
7. **A month must be explicitly opened before any entry (task or manual) can
   be recorded against it** — there is no implicit auto-creation of a month
   with a zero balance. This was chosen over silent auto-creation because a
   petty cash ledger opening at 0 without the admin's knowledge is a worse
   failure mode than a clear 400 error telling them to open it.
8. **Category is a fixed enum**, not an admin-managed table, per the "Select
   category..." dropdown shown in the mockup implying a fixed, short list.
9. **`StorageService` is stream-based, not signed-URL-based** —
   `save(buffer, options): Promise<StoredFile>` and `createReadStream(key)`,
   confirmed against the actual interface. Receipt "download links" in API
   responses are therefore paths into this module's own
   `GET /petty-cash/entries/:id/receipt` endpoint, not links to the storage
   provider — see §8.
10. **Task settlement's ledger write is not transactional with `submittedAt`**
    — see the caveat in §5.1. Treated as acceptable for this deliverable
    given the fail-loud month-not-open error is already visible to the
    caller, but flagged as a real gap rather than silently accepted.

## 11. Recommendations

- **Move pending-scan storage out of process memory** into Redis (with the
  same TTL) or a `PendingReceiptScan` table before running more than one
  instance of the API — right now a scan uploaded to instance A and confirmed
  against instance B would 404.
- **Promote `PettyCashCategory` to a lookup table** if the Admin Department
  ever asks to add/rename categories without a code deploy. Straightforward
  migration: keep the enum values as seed data, add a nullable
  `customCategoryId` alongside the enum during the transition, backfill, then
  drop the enum column.
- **Add a scheduled reminder job** (not a scheduled *reset*, deliberately —
  see §7) that notifies the admin near month-end if the next month hasn't
  been opened yet, so task settlements don't start failing on the 1st.
- **Consider a `PettyCashLedgerEntry` soft-delete (`deletedAt`)** instead of
  hard delete, once this ledger is relied on for real audits — hard delete is
  implemented here per straightforward CRUD expectations, but a financial
  ledger's usual best practice is "nothing physically disappears."
- **Total Owed to Staff**, when built, likely wants its own
  `PettyCashReimbursement` table (staff advances money personally, gets paid
  back) rather than overloading `PettyCashLedgerEntry` — keep expense
  recording and staff-owed tracking as separate concerns, the same way
  expenses and adjustments are kept separate here.
- **Make task settlement atomic with its ledger entry.** Right now
  `Task.submittedAt` and the `PettyCashLedgerEntry` it produces are two
  separate writes (§5.1). Closing this gap means changing
  `PettyCashService.createFromTask()` to accept an external
  `Prisma.TransactionClient` instead of opening its own `$transaction`, so
  `TaskModule.submit()` can wrap both writes in one transaction and roll
  back cleanly if either fails.
- **Two parallel `AdjustmentType`/category/etc. enum definitions exist** —
  one hand-written in `petty-cash.constants.ts` (for `class-validator` /
  Swagger on the DTOs, which need a real runtime object) and one
  Prisma-generates at `src/generated/prisma/enums` from the schema. They
  share the same string values but are nominally distinct TypeScript types,
  so any code that reads a Prisma query result and assigns it into a field
  typed by the local enum needs a string-literal comparison or an explicit
  cast rather than direct enum-to-enum comparison (see
  `recomputeLedgerTotals()` in `petty-cash.service.ts` for the pattern used
  here). Worth a single source of truth if this keeps coming up elsewhere in
  the codebase — e.g. re-exporting the Prisma-generated enum's runtime
  object from the constants file instead of hand-declaring a second one.