# Manual Testing Guide — Tasks + Location API

A step-by-step run through the full office-boy flow, exactly as the React Native
app would call it:

**create → start → track → end → amounts → receipt → submit**

plus cancel and the idempotency / grace-window edge cases. It also covers the
Top 10 **Employees** directory and the **Hours Saved** report the tasks link into
(sections 10–12), and the admin-side petty cash and rate endpoints (sections
13–15).

Base URL: `http://localhost:3000/api/v1`
Swagger UI: `http://localhost:3000/api/docs`

---

## 0. One-time setup

```bash
npm run prisma:seed
```

This creates (development only) two office boys and one admin. Passwords below
are the dev-seed defaults — they only apply when `NODE_ENV` is not `production`.

| Role       | Email                 | Password        |
|------------|-----------------------|-----------------|
| OFFICE_BOY | `bilal@obtrack.local` | `Password123!`  |
| OFFICE_BOY | `usman@obtrack.local` | `Password123!`  |
| ADMIN      | `admin@obtrack.local` | `ChangeMe123!`  |

It also seeds four sample **Top 10 employees** (Ahmed Raza, Sara Khan, Hamza
Sheikh, Ayesha Malik) — the people errands are run *for*, not logins. You pick
one of them when a task is flagged for a Top 10 employee (step 2) and they drive
the Hours Saved report (section 11).

Start the server:

```bash
npm run start:dev
```

The seed also inserts the **genesis reimbursement rate** — 25 per km, effective
from the Unix epoch — so every completed task can be priced from the start. See
section 15 for changing it.

Every response is wrapped by the global interceptor as
`{ "success": true, "data": { ... }, "timestamp": "..." }`. The IDs you need
(`accessToken`, task `id`) live under `data`. Paginated endpoints put their
`items` and `meta` *inside* `data` — i.e. `data.items` and `data.meta`, not a
top-level `meta`.

Two endpoints opt out of the envelope and return raw bytes: the xlsx exports and
`GET /tasks/:id/receipt`.

---

## 1. Log in as an office boy

`POST /api/v1/auth/login`

```json
{
  "email": "bilal@obtrack.local",
  "password": "Password123!"
}
```

Copy `data.tokens.accessToken` from the response. **Every task call below needs**
`Authorization: Bearer <accessToken>`. In Swagger, click **Authorize** (top
right), paste the token, and it's applied to all requests.

> Also log in as `admin@obtrack.local` in a second tab/token — you'll need the
> admin token for the ADMIN-can-read check in step 4.

---

## 2. Create a task — `POST /tasks`

Generate a fresh UUID for `clientTaskId` (any v4 UUID; Swagger's example works
once). Identity comes from your token — there is no `officeBoyId` in the body.

```json
{
  "clientTaskId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "title": "Deliver documents to head office",
  "description": "Hand the sealed envelope to reception on floor 3.",
  "destination": "Head Office, I.I. Chundrigar Road, Karachi"
}
```

Expect: `201`, task with `status: "PENDING"`, no coordinates. **Save `data.id`** —
call it `TASK_ID` for the rest of the guide.

**Idempotency check:** send the exact same body again. You get the *same* task
back (same `id`), not a duplicate. That's the `clientTaskId` upsert working.

### Flagging a task for a Top 10 employee

On the app this is the "This task is for a Top 10 Employee" checkbox plus the
employee dropdown. In the API it is a single optional field: `employeeId`. First
fetch an active employee id (any authenticated user may list them):

`GET /api/v1/employees` → copy an `id` from `data.items` (call it `EMP_ID`).

Then create a task with the link (new `clientTaskId`):

```json
{
  "clientTaskId": "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
  "description": "Collect signed forms for the maintenance lead.",
  "employeeId": "EMP_ID"
}
```

Expect: `201`, and `data.employee` echoes `{ id, name, department }`. This linked
task's time will roll up into that employee's Hours Saved once completed.

**Validation check:** send the same with a bogus `employeeId` (a random UUID, or
a deactivated employee's id) → `400 Bad Request` ("Unknown or inactive
employee."). The link is verified against an *active* employee, so a task can
never point at a stale one.

---

## 3. List my tasks — `GET /tasks`

`GET /api/v1/tasks?page=1&limit=20`

Expect your new task, newest first, scoped to you. `data.meta` carries pagination.

This is the **task history** screen, so it takes the full filter set:

| Query | Meaning |
|---|---|
| `status=PENDING` | one status (`PENDING`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`) |
| `from` / `to` | ISO-8601 bounds on `createdAt`, both inclusive |
| `employeeId` | only errands run for that Top 10 employee |
| `hasReceipt=true` / `false` | with, or without, a receipt attached |
| `submitted=false` | **the office boy's "still to hand in" list** |
| `search=bank` | case-insensitive across title, description, destination |

Combine freely, e.g.
`GET /api/v1/tasks?status=COMPLETED&submitted=false&from=2026-08-01T00:00:00.000Z`.

**Boolean check:** `?submitted=false` must return the *unsubmitted* tasks. (If a
boolean filter ever inverts, the DTO is using `@Type(() => Boolean)` instead of
the shared `parseBoolean` — `Boolean('false')` is `true`.)

---

## 4. Get one task — `GET /tasks/:id`

`GET /api/v1/tasks/{TASK_ID}` with your OB token → full task + route detail.

**Ownership checks (this is the security-critical part):**

- As **Bilal**, request Usman's task id (create one as Usman, or just try a
  random UUID you own nothing under) → `403 Forbidden`.
- As **admin** (use the admin token), request Bilal's `TASK_ID` → `200`. An
  admin may read any task.
- Any token, unknown UUID → `404 Not Found`.

---

## 5. Start the task — `POST /tasks/:id/start`

`POST /api/v1/tasks/{TASK_ID}/start`

```json
{
  "latitude": 24.8607,
  "longitude": 67.0011,
  "recordedAt": "2026-07-31T09:00:00.000Z"
}
```

Expect: `200`, `status: "IN_PROGRESS"`, `startedAt` set, start coords stored.

**State-machine check:** call `/start` again on the now-IN_PROGRESS task →
`409 Conflict` (only a PENDING task may start).

---

## 6. Stream GPS points — `POST /tasks/:id/locations`

`POST /api/v1/tasks/{TASK_ID}/locations`. Each point needs its own `clientId`
UUID. This batch deliberately includes one **noisy** point (poor accuracy) and
one **stationary** point to prove the noise filter drops them at `/end`.

```json
{
  "points": [
    {
      "clientId": "b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e01",
      "latitude": 24.8607,
      "longitude": 67.0011,
      "recordedAt": "2026-07-31T09:00:10.000Z",
      "accuracyMeters": 8,
      "isMoving": true
    },
    {
      "clientId": "b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e02",
      "latitude": 24.8620,
      "longitude": 67.0025,
      "recordedAt": "2026-07-31T09:01:00.000Z",
      "accuracyMeters": 6,
      "isMoving": true
    },
    {
      "clientId": "b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e03",
      "latitude": 24.9000,
      "longitude": 67.0500,
      "recordedAt": "2026-07-31T09:01:30.000Z",
      "accuracyMeters": 250,
      "isMoving": true
    },
    {
      "clientId": "b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e04",
      "latitude": 24.8640,
      "longitude": 67.0050,
      "recordedAt": "2026-07-31T09:02:00.000Z",
      "accuracyMeters": 5,
      "isMoving": false
    },
    {
      "clientId": "b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e05",
      "latitude": 24.8660,
      "longitude": 67.0080,
      "recordedAt": "2026-07-31T09:03:00.000Z",
      "accuracyMeters": 7,
      "isMoving": true
    }
  ]
}
```

Expect: `200` with accepted/received counts. Status stays `IN_PROGRESS`.

**Idempotency check:** re-POST the exact same batch. Received count is the same,
but accepted (newly inserted) is `0` — the `clientId` upsert skipped every
duplicate. No double-counting of distance later.

Point #3 (`accuracyMeters: 250`, over the 50 m threshold) and point #4
(`isMoving: false`) will be filtered out when the route is computed at `/end`.

---

## 7. End the task — `POST /tasks/:id/end`

`POST /api/v1/tasks/{TASK_ID}/end`

```json
{
  "latitude": 24.8660,
  "longitude": 67.0080,
  "recordedAt": "2026-07-31T09:03:30.000Z"
}
```

Expect: `200`, `status: "COMPLETED"`, and the computed totals populated:

- `distanceMeters` — haversine sum over the **surviving** points only.
- `durationSeconds` — `(endedAt − startedAt) / 1000` ≈ `210`.
- a `route` with an `encodedPolyline` and the kept-vs-filtered point counts.
- `amountReceived: 0`, `amountReturned: 0`, `netAmount: 0` — a task always
  completes with a zeroed money picture. The real amounts are recorded in the
  next step.
- `submittedAt: null` — ended, but not yet handed in.

The two bad points should NOT contribute to distance — that's the filter earning
its place. All of this happens in one transaction, so a COMPLETED task always has
its route.

**`/end` does not accept the settlement amounts.** `PATCH /tasks/:id/settlement`
(section 9a) is the only route that writes them, matching the product flow where
"end" and "enter the amounts" are separate screens. Sending them here → `400`:

```json
{
  "latitude": 24.8660,
  "longitude": 67.0080,
  "recordedAt": "2026-07-31T09:03:30.000Z",
  "amountReceived": 500
}
```

→ `400 Bad Request` (`property amountReceived should not exist`). A loud
rejection on purpose: two routes writing the same columns, with different
meanings for an omitted field, let an amounts screen that saves on mount silently
zero what `/end` had just stored.

**State-machine check:** call `/end` again → `409` (task is no longer
IN_PROGRESS).

---

## 8. Grace-window late points (recompute)

The phone often flushes a few buffered points *after* the OB taps "end". A batch
to a COMPLETED task is still accepted if it lands within the grace window
(default 10 minutes after `endedAt`) and the route is recomputed inline.

Immediately after step 7, POST one more point to `/locations`:

```json
{
  "points": [
    {
      "clientId": "b7e6c9a2-1f4d-4c3a-9b8e-2d1c0a9f8e06",
      "latitude": 24.8680,
      "longitude": 67.0110,
      "recordedAt": "2026-07-31T09:03:45.000Z",
      "accuracyMeters": 6,
      "isMoving": true
    }
  ]
}
```

Expect: `200`. Then `GET /tasks/{TASK_ID}` again — `distanceMeters` and the
polyline have grown to include the late point. (Outside the window it would be
`409`.)

---

## 9. Cancel — `POST /tasks/:id/cancel`

Create a *fresh* task (step 2 with a new `clientTaskId`), then:

`POST /api/v1/tasks/{NEW_TASK_ID}/cancel`

```json
{
  "cancellationReason": "Customer not available at the destination."
}
```

Expect: `200`, `status: "CANCELLED"`. Works from PENDING or IN_PROGRESS.

**With a cancellation location (optional).** Like start and end, cancel can carry
a GPS fix — where the office boy was when they gave up on the errand. All three
coordinate fields are optional; send them alongside the reason:

```json
{
  "cancellationReason": "Customer not available at the destination.",
  "latitude": 24.8607,
  "longitude": 67.0011,
  "recordedAt": "2026-07-31T09:00:00.000Z"
}
```

Expect: `200`. `GET /tasks/{NEW_TASK_ID}` now shows `cancelLatitude` and
`cancelLongitude` populated (`recordedAt` is informational — `cancelledAt` is
stamped server-side). Cancelling with the reason alone (no coordinates) still
returns `200`; the location columns simply stay `null`.

**State-machine check:** try to cancel your COMPLETED `TASK_ID` from step 7 →
`409` (terminal states cannot be cancelled).

---

## 9a. Record the settlement — `PATCH /tasks/:id/settlement`

The wizard's "Amount Received / Amount Returned / Vendor" screen, and **the only
route that writes those columns**. Also how a mistyped entry is corrected, right
up until the task is submitted.

`PATCH /api/v1/tasks/{TASK_ID}/settlement`

```json
{
  "amountReceived": 500,
  "amountReturned": 120.5,
  "vendorDetails": "Al-Fatah Superstore, Gulberg — invoice #A-4471"
}
```

Expect: `200`, with `amountReceived: 500`, `amountReturned: 120.5`,
`netAmount: 379.5`, and the vendor echoed back.

Check the type on the amounts: they must come back as JSON **numbers** (`500`),
not strings (`"500"`). They are `Decimal` columns, so a missing conversion shows
up here.

Things to check:

- **Every field optional; omitting one RESETS it.** Send `{}` → both amounts
  become `0` and `vendorDetails` becomes `null`. This is a PATCH of *the
  settlement as a whole*, so clearing a box means "nothing", not "leave the old
  value". (That semantic is exactly why `/end` no longer accepts amounts — a
  screen that saved itself empty would have wiped them.)
  > **For the app team:** pre-fill this form from the task before showing it.
- **An empty vendor string becomes `null`.** `{"vendorDetails": ""}` → stored as
  `null`, not `""`. Same gesture, one state.
- **Vendor is free text, max 500 characters.** 501 → `400`. It is deliberately
  not a foreign key to a vendor table: an errand goes wherever it goes, and an
  office boy standing at an unfamiliar counter must not be blocked.
- **Only on a COMPLETED task.** Try it on a PENDING or IN_PROGRESS task → `409`
  ("End the task first.").
- **Two decimal places.** `{"amountReceived": 10.999}` → `400`. The column is
  `Decimal(12,2)`; rejecting is better than silently rounding what was typed.
- **Negative rejected.** `{"amountReceived": -5}` → `400`.
- **Searchable.** `GET /api/v1/tasks?search=al-fatah` (and the admin's
  `GET /admin/tasks?search=al-fatah`) now matches on the vendor as well as
  title/description/destination — "what did we spend at this shop" is the
  question a petty-cash screen exists to answer.

---

## 9b. Upload a receipt — `POST /tasks/:id/receipt`

`multipart/form-data`, one field named `file`. Accepted types: JPEG, PNG, WebP,
PDF. Max 5 MB (`MAX_RECEIPT_BYTES`).

```bash
curl -X POST http://localhost:3000/api/v1/tasks/$TASK_ID/receipt \
  -H "Authorization: Bearer $OB_TOKEN" \
  -F "file=@receipt.jpg"
```

Expect: `200` and the updated task, whose `receipt` now carries
`{ id, originalName, mimeType, sizeBytes, uploadedAt }`. The bytes themselves are
never in a task response.

**The checks that matter:**

| Attempt | Expect | Why |
|---|---|---|
| Rename `notes.txt` → `receipt.jpg`, upload it | `400` | The type is read from the file's **magic bytes**, not the declared `Content-Type`. A renamed script must not be stored as an image. |
| A file over 5 MB | `413`/`400` | multer aborts mid-transfer; the service re-checks against the configured limit. |
| No `file` field at all | `400` | "A receipt file is required." |
| Upload a second file to the same task | `200` | Replaces the first. Check `uploads/` on disk — the old file is gone, not orphaned. |
| Upload after submitting (step 9d) | `409` | The record is frozen. |

**Download** — `GET /api/v1/tasks/{TASK_ID}/receipt` streams the bytes with the
stored `Content-Type` and `Content-Disposition: inline`. No envelope.

- As the **owning** office boy → `200`.
- As **admin** → `200` (they need it to book the expense).
- As a **different** office boy → `403`.
- On a task with no receipt → `404`.

**Delete** — `DELETE /api/v1/tasks/{TASK_ID}/receipt` → `200`, and the file
really leaves `uploads/`. Refused with `409` after submitting.

---

## 9c. What the office boy still owes — `GET /tasks?submitted=false`

`GET /api/v1/tasks?status=COMPLETED&submitted=false` is the "finish your
paperwork" list. It should contain the task from 9a/9b and disappear from it the
moment you submit.

`GET /api/v1/tasks/stats` carries the same figure as `pendingSubmission`, along
with `totalAmountReceived`, `totalAmountReturned`, `netAmount`, and
`reimbursementAmount` — what the office boy has earned back, priced at the rate
in force when each task ended.

---

## 9d. Submit — `POST /tasks/:id/submit`

`POST /api/v1/tasks/{TASK_ID}/submit` (no body)

Expect: `200` with `submittedAt` stamped. The task is now frozen and appears on
the admin's petty cash feed (section 13).

- **A receipt is NOT required.** Submit a task with no receipt → `200`. Not every
  errand produces one.
- **Submitting twice → `409`,** not a silent success. A double submit means the
  client thinks it has something new to hand in; agreeing quietly would hide that.
- **Then re-try `PATCH /settlement` → `409`,** and the same for uploading or
  deleting the receipt. This is the freeze.
- Submitting a task that was never completed → `409`.

---

## 10. Employees directory — `/employees` (admin CRUD + OB dropdown)

Employees are the "Top 10" people errands are run *for*. The directory is
admin-managed; the office boy only reads the active list for the dropdown.

**As an office boy (read-only):**

`GET /api/v1/employees?page=1&limit=20` → active employees, sorted by name, with
`meta` pagination. This is the only employee route an office boy may call.

- `POST /api/v1/employees` as an office boy → `403 Forbidden`.

**As admin** (use the admin token):

Create — `POST /api/v1/employees`:

```json
{
  "name": "Zainab Iqbal",
  "department": "Procurement Dept"
}
```

Expect: `201` with `isActive: true`. **Save `data.id`** as `EMP_ID`.

- List with filters: `GET /api/v1/employees?search=zainab&isActive=false`. As
  **admin** this really returns deactivated employees; as an **office boy** the
  same query still returns only active ones, because the dropdown must never
  offer a retired name.
- Fetch one: `GET /api/v1/employees/{EMP_ID}` → `200`; unknown UUID → `404`
  (a real 404, not `200` with a `null` body).
- Update: `PATCH /api/v1/employees/{EMP_ID}` with `{ "department": "Admin Dept" }`
  → `200`; unknown UUID → `404`.
- Deactivate: `POST /api/v1/employees/{EMP_ID}/deactivate` → `200`, `isActive:
  false`. Re-run the office boy's `GET /employees` → this name is **gone** from
  the list, and `POST /tasks` with `employeeId: EMP_ID` now → `400`.
- Reactivate: `POST /api/v1/employees/{EMP_ID}/activate` → `200`, back in the
  list.

**The Top 10 cap.** At most **10 employees may be active at once** — that is what
"Top 10" means here, and it is enforced, not aspirational. The seed creates four,
so create six more, then:

- An 11th `POST /api/v1/employees` → `409` ("At most 10 employees may be active
  at once."). Nothing is created.
- Deactivate one, and the create now succeeds.
- With ten active, `POST /employees/{id}/activate` on a *deactivated* one → `409`
  too. (Activating has to respect the cap, or it is a way straight around it.)
- Re-activating someone who is **already** active → `200`. They already hold
  their own slot.

**Delete — `DELETE /api/v1/employees/{EMP_ID}`.**

- On a brand-new employee with no tasks → `200`, gone for good.
- On an employee that has any task → `409`, and the message says how many:
  *"Employee has 3 linked task(s) and cannot be deleted. Deactivate them
  instead…"*. Their tasks are the raw material of the Hours Saved report;
  deleting them would rewrite history. Deactivation is the intended retirement.
- Unknown UUID → `404`. Office boy calling it → `403`.

---

## 11. Top 10 — Hours Saved — `GET /employees/hours-saved` (admin)

The dedicated dashboard tab. "Hours saved" = the total office-boy time spent on
an employee's **COMPLETED** tasks, expressed in hours.

To see a non-zero figure, run one linked task end-to-end first: create a task
with an `employeeId` (step 2), then `start` → stream `locations` → `end` it so it
has a settled `durationSeconds`.

`GET /api/v1/employees/hours-saved` (admin token) →

```json
{
  "rows": [
    {
      "employeeId": "…",
      "name": "Ahmed Raza",
      "department": "Maintenance Dept",
      "isActive": true,
      "completedTasks": 1,
      "totalDurationSeconds": 210,
      "totalDistanceMeters": 812.4,
      "hoursSaved": 0.06
    }
  ],
  "totals": {
    "employees": 1,
    "completedTasks": 1,
    "totalDurationSeconds": 210,
    "totalDistanceMeters": 812.4,
    "totalHoursSaved": 0.06
  }
}
```

- Ranked by time spent, highest first. `totals.totalHoursSaved` is the
  **collective** figure for the tab header.
- Only COMPLETED tasks count — a cancelled or in-progress linked task adds
  nothing.
- **Windowed:** `?from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z`
  narrows to tasks that *finished* in that range (not ones created in it).
- **Deactivated employees stay on the report**, flagged `isActive: false` — their
  historical hours are exactly what a year-end summary is asking about.
- **Cross-role check:** an office boy calling `GET /employees/hours-saved` →
  `403 Forbidden`.

**Per-employee detail** — `GET /api/v1/employees/{EMP_ID}/stats` (admin) gives
one employee's full picture: task counts per status, completed count, hours
saved, distance, average task duration, and first/last activity. Same optional
`from`/`to`.

---

## 12. Export Hours Saved — `GET /employees/hours-saved/export`

`GET /api/v1/employees/hours-saved/export` (admin) downloads an `.xlsx` of the
same rows and window. The collective totals are appended as a final **TOTAL**
row, so the number the spec asks for survives being copied out of Excel.

```bash
curl -OJ -H "Authorization: Bearer $ADMIN_TOKEN" \
  "http://localhost:3000/api/v1/employees/hours-saved/export"
```

Open it and check the Employee / Department / Active / Completed Tasks / Total
Time / Hours Saved / Distance columns, and the TOTAL row at the bottom.

---

## 13. Petty cash feed — `GET /admin/receipts` (admin)

This is where the receipt and amounts from sections 9a–9d surface for the admin
to book as an expense.

`GET /api/v1/admin/receipts?page=1&limit=20`

Each item carries the task, the office boy, the employee (if any),
`amountReceived`, `amountReturned`, the derived `netAmount`, `vendorDetails`,
`submittedAt`, the receipt metadata, and a ready-to-use `receiptUrl`
(`/api/v1/tasks/{id}/receipt`) — or `null` when nothing was attached.

The vendor sits next to the amount on purpose: an expense line is reconciled
against *what was spent* and *who it went to* together, so a feed carrying one
without the other sends the admin back to the task detail for every row.

Filters: `officeBoyId`, `from`/`to` (on completion), `hasReceipt`, `submitted`.

- `?submitted=true` → the **ready to book** queue.
- `?hasReceipt=false&submitted=true` → handed in with **no** receipt: the chase list.
- `data.totals` covers the **whole filtered set**, not just the current page —
  reconciling a month needs the month's figure, not page 1 of it.

Follow a `receiptUrl` with the admin token → the image streams back (`200`).

---

## 14. Office boy statistics + exports (admin)

- `GET /api/v1/admin/office-boys/stats` — one row per office boy: task counts per
  status, completed work, distance, duration, average task length, cash handled,
  and reimbursement owed, plus fleet `totals`. An office boy who has done nothing
  still appears as a zero row — absence would read as a missing record.
- `GET /api/v1/admin/office-boys/{id}/stats` — the same shape for one person.
- `?from=…&to=…` windows the completed-work figures. The per-status counts are
  deliberately **not** windowed: "how many are pending" is a question about now,
  and a pending task has no completion date to filter on.
- `GET /api/v1/admin/office-boys/stats/export` → `.xlsx`.
- `GET /api/v1/admin/tasks/export` → `.xlsx`, now including **Amount Received /
  Amount Returned / Net Spent / Receipt / Receipt File / Submitted At**. Uses the
  same filters as `GET /admin/tasks`, so you export exactly what you filtered.
- `GET /api/v1/admin/reimbursements/export` → `.xlsx`.

Exports are capped at 10,000 rows; when the cap bites, the response carries
`X-Export-Truncated: true`. A browser can read that header (and the filename)
because `main.ts` lists both in the CORS `exposedHeaders`.

---

## 15. Reimbursement rate per km — `/admin/reimbursement-rates` (admin)

The rate is **effective-dated history**, not a mutable setting: a task is priced
at the rate that was in force when it *ended*, so changing the rate today never
restates last month's report.

`GET /api/v1/admin/reimbursement-rates` → the history, newest first, with who set
each rate and why. On a fresh database this is the single genesis row at 25/km
from the epoch.

Set a new rate — `POST /api/v1/admin/reimbursement-rates`:

```json
{
  "ratePerKm": 40,
  "note": "FY27 fuel adjustment approved by finance"
}
```

`effectiveFrom` defaults to now; pass a future ISO date to schedule a change.

**The check worth doing properly:**

1. Note the `amount` for your office boy in `GET /api/v1/admin/reimbursements`.
2. `POST` the new rate of 40.
3. Run a **second** task end-to-end so there is distance on both sides of the
   change.
4. `GET /api/v1/admin/reimbursements` again. The response now has
   `currentRatePerKm: 40`, a `rates` array of both periods, and each row's
   `breakdown` shows the old distance still priced at **25** and the new distance
   at **40**. The first task's contribution must not have changed.

Other behaviour:

- Two rates at the exact same instant → `409`.
- `DELETE /api/v1/admin/reimbursement-rates/{id}` on a **future-dated** rate →
  `200` (withdrawing a scheduled change is legitimate).
- The same on a rate already **in force** → `409`. It has priced completed work;
  append a new rate instead of rewriting history.

`GET /api/v1/admin/stats` also reports `currentRatePerKm`, and returns `null`
rather than a made-up number if no rate has ever been configured.

---

## Quick coverage checklist

**Office boy flow**

- [ ] Login returns a token; task calls without it → `401`
- [ ] Create → `PENDING`; same `clientTaskId` twice → one task
- [ ] Create with valid `employeeId` links the employee; bogus/inactive → `400`
- [ ] List scoped to me; status / date / employee / receipt / submitted / search filters
- [ ] `?submitted=false` returns unsubmitted tasks (not inverted)
- [ ] Get: owner ✓, admin ✓, other OB → `403`, unknown → `404`
- [ ] Start: PENDING → IN_PROGRESS; again → `409`
- [ ] Locations: batch stored; re-POST → `0` accepted; noisy/stationary flagged
- [ ] End: COMPLETED with distance + duration + route; again → `409`
- [ ] End always leaves both amounts `0`; sending amounts to `/end` → `400`
- [ ] Late point within grace window → recompute; cancel COMPLETED → `409`
- [ ] Cancel: PENDING/IN_PROGRESS → CANCELLED with reason
- [ ] Cancel with `latitude`/`longitude` → coords stored; reason-only still `200`
- [ ] Settlement: `{}` → amounts `0` and vendor `null`; non-COMPLETED → `409`; `10.999` → `400`
- [ ] Settlement returns amounts as **numbers**, not strings
- [ ] Vendor: stored and echoed; `""` → `null`; over 500 chars → `400`
- [ ] `?search=<vendor>` matches on the vendor, on both the OB and admin lists
- [ ] Receipt: real JPEG ✓; renamed `.txt` → `400`; >5 MB → `400`; re-upload replaces
- [ ] Receipt download: owner ✓, admin ✓, other OB → `403`, none attached → `404`
- [ ] Submit: `200` with no receipt; twice → `409`; then settlement/receipt → `409`
- [ ] `GET /tasks/stats` shows `pendingSubmission` and `reimbursementAmount`

**Admin**

- [ ] Employees: OB reads active list; OB write → `403`; admin CRUD + activate/deactivate
- [ ] Deactivated employee drops from dropdown and blocks new task links (`400`)
- [ ] Admin `?isActive=false` really returns deactivated employees
- [ ] `GET /employees/{unknown-uuid}` → `404`, not `200` with `null`
- [ ] 11th active employee → `409`, on create **and** on activate
- [ ] `DELETE /employees/:id`: unused ✓; with tasks → `409` naming the count
- [ ] Hours Saved: ranked, `totals.totalHoursSaved` present, deactivated still listed
- [ ] `GET /employees/:id/stats` and the hours-saved `.xlsx` export
- [ ] `GET /admin/receipts`: netAmount, vendor, `receiptUrl`, filters, whole-set totals
- [ ] `GET /admin/office-boys/stats`: zero rows for idle office boys, footer totals
- [ ] `?completedToday=false` returns the **unfiltered** list (not today's)
- [ ] Rate change: old tasks keep the old price, `breakdown` shows both periods
- [ ] Delete a scheduled rate ✓; delete an in-force rate → `409`
- [ ] All four `.xlsx` exports download and open; task export has the money columns
