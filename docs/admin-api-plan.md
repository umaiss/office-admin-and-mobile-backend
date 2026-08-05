# Plan — Admin surface: tasks, stats, reimbursements, export

## Endpoints being added

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/v1/admin/tasks` | ADMIN | List all tasks, filtered + paginated |
| GET | `/api/v1/admin/tasks/:id` | ADMIN | View any task with route |
| GET | `/api/v1/admin/tasks/export` | ADMIN | Export filtered tasks as `.xlsx` |
| GET | `/api/v1/admin/stats` | ADMIN | Overall dashboard stats |
| GET | `/api/v1/admin/reimbursements` | ADMIN | Reimbursements derived from completed tasks |
| GET | `/api/v1/tasks/stats` | OFFICE_BOY | My statistics |

Decisions locked (from your answers): reimbursements are **derived** (distance × rate, no new table), export is **Excel .xlsx** (adds `exceljs`), admin routes live in a **new AdminModule**.

## New module: `src/admin/`

```
src/admin/
  admin.module.ts
  admin.controller.ts        // 5 ADMIN routes, @Roles(Role.ADMIN) at class level
  admin.service.ts           // list, findOne, stats, reimbursements, export data
  admin-export.service.ts    // builds the xlsx workbook (isolates exceljs)
  reimbursement.constants.ts // REIMBURSEMENT_RATE_PER_KM (named constant, like LATE_POINT_GRACE_MS)
  dto/
    admin-list-tasks-query.dto.ts   // status, officeBoyId, from, to, completedToday, search, page, limit
    reimbursements-query.dto.ts     // officeBoyId?, from?, to?  (COMPLETED only)
```

`AdminModule` imports `TasksModule` (already exports `TasksService`) so admin's single-task view reuses the exact `findOne` allowlist + route select. Registered in `app.module.ts` feature list. PrismaService comes from the global PrismaModule.

## Route ordering (critical)

`GET /admin/tasks/export` and `/admin/tasks/:id` share a prefix. `export` must be declared **before** `:id` in the controller, otherwise Nest matches `export` as an `:id` value. (Also, `:id` uses `ParseUUIDPipe`, so `export` would 400 rather than mismatch — but explicit ordering is clearer and safe.)

## 1. `GET /admin/tasks` — list all with filters

`AdminListTasksQueryDto`:
- `page` / `limit` — same shape/defaults as `ListTasksQueryDto` (1, 20, max 100).
- `status?` — `IsEnum(TaskStatus)`.
- `officeBoyId?` — `IsUUID`.
- `from?` / `to?` — `IsISO8601`, filter on `createdAt`.
- `completedToday?` — boolean; when true, overrides to `status=COMPLETED` AND `endedAt` within today (server local day → UTC range).
- `search?` — trimmed string; case-insensitive `contains` across `title` / `description` / `destination` (Prisma `OR` + `mode: 'insensitive'`).

Service `listAll(query)`: builds `where`, runs `findMany` + `count` in one `$transaction` (mirrors `TasksService.findMany`), uses `TASK_SELECT`, `orderBy: createdAt desc`, returns `{ items, meta }` with `PaginationMetaDto`. Uses the `@@index([status, createdAt])` that already exists for exactly this.

## 2. `GET /admin/tasks/:id` — view any task

Delegates to `tasksService.findOne(userId, Role.ADMIN, id)`. Passing `Role.ADMIN` means the existing ownership branch is skipped and any task (with route) is returned — no new query logic, no field-leak risk. 404 on missing id is already handled there.

## 3. `GET /admin/tasks/export` — Excel

- Same `AdminListTasksQueryDto` filters as the list (export what you filtered).
- `admin-export.service.ts` uses `exceljs` streaming workbook writer. Columns: task id, title, office boy name+email (join via `officeBoy` select), status, destination, createdAt, startedAt, endedAt, cancelledAt, distanceMeters, durationSeconds, cancellationReason.
- Controller sets `Content-Type` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) and `Content-Disposition: attachment; filename="tasks-export-<date>.xlsx"`, writes to the `@Res()` Express stream.
- **Bypasses the global ResponseInterceptor** by using `@Res({ passthrough: false })` — the interceptor wraps JSON envelopes and would corrupt a binary body. This is the one route that streams instead of returning an object.
- Cap: reuse a sane upper bound (e.g. no pagination but a hard `take` ceiling, e.g. 10000 rows, and `log()`/note if truncated) so export can't stream millions of rows unbounded.

## 4. `GET /admin/stats` — dashboard

Single `$transaction` of cheap aggregates:
- `groupBy(status)` → counts per status (PENDING/IN_PROGRESS/COMPLETED/CANCELLED).
- `count` total tasks; `count` completed today (endedAt in today's range).
- `aggregate` `_sum.distanceMeters` and `_sum.durationSeconds` over COMPLETED.
- `count` active office boys (`user.count({ role: OFFICE_BOY, isActive: true })`).
Returns a flat DTO: `{ tasks: {...counts}, completedToday, totalDistanceMeters, totalDurationSeconds, activeOfficeBoys }`.

## 5. `GET /admin/reimbursements` — derived

- `ReimbursementsQueryDto`: `officeBoyId?`, `from?`, `to?` (all optional). Scope = **COMPLETED tasks only** (reimbursement is for finished work).
- Service groups COMPLETED tasks by `officeBoyId`, sums `distanceMeters`, computes `amount = (distanceMeters / 1000) * REIMBURSEMENT_RATE_PER_KM`, rounded to 2 dp.
- `REIMBURSEMENT_RATE_PER_KM` — named constant in `reimbursement.constants.ts` with a doc comment explaining it's a business rule kept out of the shared env schema (same rationale the codebase uses for `LATE_POINT_GRACE_MS`). Default e.g. `25` (currency-agnostic; documented as "per km").
- Returns per-office-boy rows: `{ officeBoyId, name, email, completedTasks, totalDistanceMeters, ratePerKm, amount }` plus a grand total. Join name/email via a grouped query then a `user.findMany` on the ids (avoids N+1).

## 6. `GET /tasks/stats` — office boy's own

Added to the **existing** `TasksController` + `TasksService` (it's the OB's own data, belongs with the OB task surface). `@Roles(Role.OFFICE_BOY)`. Same aggregate shape as admin stats but hard-scoped to `officeBoyId = userId`: counts per status, completed today, my total distance + duration. Declared before `@Get(':id')` so `stats` isn't parsed as an id.

## Dependency

Add `exceljs` to `package.json` (`npm install exceljs`). It's the only new runtime dep. Isolated to `admin-export.service.ts` so nothing else imports it.

## Response envelope

List/stats/reimbursements return plain objects → wrapped by the global `ResponseInterceptor` automatically (consistent with every other endpoint). Only `export` opts out (binary stream).

## Tests

- `admin.service.spec.ts` — mocked PrismaService (mirrors `tasks.service.spec.ts` pattern): list filters build correct `where`; stats aggregation shape; reimbursement amount math (distance→km→amount, rounding); search OR clause.
- `tasks.service.spec.ts` — add a `stats` test (scoped where clause, completed-today range).
- Export: a small unit test on the workbook builder (row mapping) with a couple of fake tasks; assert column values. Keep it light — no full HTTP round-trip.

## Verification

`npm run lint` · `npm run build` · `npx jest src/admin src/tasks` — all must pass, matching the gate used for the task module.

## Explicitly NOT doing

- No `Reimbursement` table / approval workflow (deferred per your choice).
- No CSV path (Excel only, per your choice).
- No edit/delete admin task routes (out of scope; lifecycle stays state-machine driven).

---

# Addendum — what shipped after this plan

The six endpoints above were built as described. A later pass, closing the rest
of the product spec, changed two of those decisions and added five more routes.

## Changed: the per-km rate is no longer a constant

`REIMBURSEMENT_RATE_PER_KM` in `reimbursement.constants.ts` is **gone**. The spec
requires the admin to be able to set the rate, and a single mutable value would
have silently restated every past month's report the moment it changed.

It is now **effective-dated history** — `ReimbursementRate` rows, one per change,
each applying to `[effectiveFrom, <the next row's effectiveFrom>)`. A task is
priced at the rate in force when it *ended*. The logic lives in
`src/reimbursement/reimbursement-rate.service.ts`, its own leaf module so both
`AdminModule` and `TasksModule` can use it without a cycle.

`GET /admin/reimbursements` therefore changed shape — **breaking for the
dashboard**:

| Before | After |
|---|---|
| `ratePerKm` (top level) | `currentRatePerKm` + `rates[]` (the periods) |
| row `{ …, ratePerKm, amount }` | row `{ …, amount, breakdown[] }` |

`breakdown` splits a row's amount across the rate periods it spans, which is what
makes the total explainable when a query window straddles a rate change.

The migration seeds a **genesis rate of 25/km from the Unix epoch**, so existing
figures are unchanged and no instant in history falls outside every period.

New routes: `GET`/`POST /admin/reimbursement-rates`, and
`DELETE /admin/reimbursement-rates/:id` (future-dated rates only — a rate already
in force has priced completed work and is history).

## Changed: `exceljs` moved behind a shared service

Four reports now export, not one. `exceljs` is imported in exactly one file —
`src/common/export/excel-export.service.ts` — which owns "how a workbook is
made". `admin-export.service.ts` is reduced to **column definitions**, and
`EXPORT_ROW_CEILING` / the `X-Export-Truncated` header apply uniformly.

`main.ts` now lists `Content-Disposition` and `X-Export-Truncated` in the CORS
`exposedHeaders`; without that the dashboard could not read either, so the
truncation signal the server took care to set was invisible to its only consumer.

## Added

| Route | Purpose |
|---|---|
| `GET /admin/office-boys/stats` | one row per office boy — status counts, completed work, distance, duration, average task length, cash handled, reimbursement owed — plus fleet totals. Idle office boys appear as zero rows. |
| `GET /admin/office-boys/:id/stats` | the same shape for one person |
| `GET /admin/office-boys/stats/export` | xlsx |
| `GET /admin/reimbursements/export` | xlsx |
| `GET /admin/receipts` | the petty cash feed: completed tasks with `amountReceived`, `amountReturned`, `netAmount`, `vendorDetails`, receipt metadata and a `receiptUrl`, filterable by office boy / period / has-receipt / submitted, with totals over the **whole** filtered set |

`GET /admin/stats` gained `pendingSubmissions`, `tasksWithReceipt`,
`totalAmountReceived`, `totalAmountReturned`, `netAmount`, and
`currentRatePerKm` (`null` rather than a made-up number when none is set).

`GET /admin/tasks` and its export gained `employeeId`, `hasReceipt` and
`submitted` filters, and the export gained Amount Received / Amount Returned /
Net Spent / Vendor / Receipt / Receipt File / Submitted At columns.

`search` now also matches `vendorDetails`, on both the admin list and the office
boy's own history — "what did we spend at this shop" is the question a petty cash
screen exists to answer, and a vendor column you cannot filter by is half a
feature. The vendor is deliberately free text on the task rather than a `Vendor`
table: errands go wherever they go, and requiring a pre-registered vendor would
block an office boy standing at an unfamiliar counter. If vendor spend ever needs
grouping or per-vendor totals, that is the point to normalise it.

## Defect fixed in the original build

`completedToday` used `@Type(() => Boolean)`. `Boolean('false')` is `true`, so
`?completedToday=false` switched the override **on** and pinned every result to
today — the opposite of what the caller asked, silently. It now uses the shared
`parseBoolean` transform from `src/common/transforms/boolean.transforms.ts`,
which is also what `ListUsersQueryDto` had been using all along.

Also: `todayUtcRange` was computing the day boundary with `setHours`, i.e. the
*server's local* midnight despite its name and the contract admin stats relied
on. It is now real UTC arithmetic offset by `REPORT_TZ_OFFSET_MINUTES`, so the
reporting day is a business decision rather than a property of the container.
