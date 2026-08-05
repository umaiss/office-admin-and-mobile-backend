# Building the Tasks + Location APIs — step-by-step guide

This is a working guide for building the task lifecycle and location-tracking
APIs in the OB Track backend, while collaborating with another developer on
GitHub. Keep it open as you go.

**Decisions locked in:**
- Only **office boys** create tasks. Admins monitor (read-only).
- Task creation is **independent of location** — a task is created `PENDING`
  with no coordinates.
- GPS points arrive as **batch uploads**, upserted on `TaskLocation.clientId`.
- RN library on the device: **react-native-background-geolocation**.
- Late points (arriving after a task is ended) are **accepted within a grace
  window and the route/distance is recomputed** — the realistic behaviour,
  because phones flush buffered points after coming back online.

The Task / TaskLocation / Route tables **already exist** in the database
(migration `phase1_tracking_domain`). So this work adds a NestJS module only —
**no new migration** unless you change the schema. That also means no migration
conflicts with your teammate.

---

## Part A — GitHub workflow (do this first, every time)

Since you're sharing the repo, the habits here matter more than the code.

### A1. Start from an up-to-date main

```bash
git checkout main
git pull origin main
```

Never branch off a stale main — it's the #1 cause of painful merges.

### A2. Create a feature branch

One branch per logical piece of work. Since you own the whole tasks module,
a single well-scoped branch is fine:

```bash
git checkout -b feat/tasks-module
```

Naming convention (pick one and stay consistent with your teammate):
`feat/...`, `fix/...`, `chore/...`.

### A3. Commit in small, meaningful steps

Not one giant commit at the end. Commit after each working slice:

```bash
git add .
git commit -m "feat(tasks): scaffold module, controller, service"
```

Use a consistent prefix (`feat(tasks): ...`). Small commits make review and
`git bisect` actually useful.

### A4. Push early, open a Draft PR

```bash
git push -u origin feat/tasks-module
```

Then open a **Draft** pull request on GitHub immediately, even before it's done.
Why: your teammate can see what you're touching and avoid colliding with you.
Write in the PR description which files you're adding.

### A5. Keep your branch fresh while you work

If your teammate merges to main while you're building, pull their changes into
your branch regularly so the final merge is boring:

```bash
git fetch origin
git merge origin/main      # or: git rebase origin/main (agree on one with your teammate)
```

Agree with your teammate on **merge vs rebase** and stick to it — mixing them on
a shared branch causes confusion.

### A6. Avoiding conflicts with your teammate

- The one file you'll **both** likely edit is `src/app.module.ts` (to register a
  new module in the `imports` array). This is a classic conflict point. If it
  conflicts, the fix is trivial: keep **both** module imports. Tell each other
  when you add a module.
- The Prisma `schema.prisma` and `src/generated/prisma/**` are also shared. You
  are **not** changing the schema, so don't touch these. If your teammate
  regenerates the client, just re-pull.
- Never commit `.env`. Confirm it's in `.gitignore`.

### A7. Finish

Mark the PR "Ready for review", request your teammate, address comments, then
**Squash and merge** (keeps main history clean). Delete the branch after merge.

---

## Part B — What you're building (the endpoints)

All under the existing `/api/v1` prefix. Identity always comes from the token
(`@CurrentUser('userId')`), never from the request body.

| # | Method & path | Purpose | Role |
|---|---|---|---|
| 1 | `POST /api/v1/tasks` | Create a task (upsert on `clientTaskId`) | OFFICE_BOY |
| 2 | `GET /api/v1/tasks` | List my tasks (paginated, filter by status) | OFFICE_BOY |
| 3 | `GET /api/v1/tasks/:id` | One task with details | owner or ADMIN |
| 4 | `POST /api/v1/tasks/:id/start` | PENDING → IN_PROGRESS, save start location | OFFICE_BOY |
| 5 | `POST /api/v1/tasks/:id/locations` | Batch upload GPS points (upsert on `clientId`) | OFFICE_BOY |
| 6 | `POST /api/v1/tasks/:id/end` | IN_PROGRESS → COMPLETED, save end location, compute route + distance + duration | OFFICE_BOY |
| 7 | `POST /api/v1/tasks/:id/cancel` | → CANCELLED with a reason | OFFICE_BOY |

You can ship in slices (see Part D). 1, 4, 5, 6 are the core.

---

## Part C — File structure to create

Mirror the existing `users/` module exactly — same conventions.

```
src/tasks/
  tasks.module.ts
  tasks.controller.ts
  tasks.service.ts
  dto/
    create-task.dto.ts          # clientTaskId, title, description, destination?
    task-location.dto.ts        # one point + the batch wrapper
    location-point.dto.ts       # start/end single-fix body (lat, lng, recordedAt)
    end-task.dto.ts             # end fix (extends/uses location-point)
    cancel-task.dto.ts          # cancellationReason
    list-tasks.query.dto.ts     # page, limit, status
  tasks.service.spec.ts         # unit tests
  distance.ts                   # pure helper: haversine + noise filter (easy to test)
```

Register the module in `src/app.module.ts` under `// Feature modules`.

---

## Part D — Build order (each is a commit + keeps the app runnable)

Build in this sequence so every step compiles and can be tested before the next.

### Step 1 — Scaffold (commit: "scaffold module")
Create `tasks.module.ts`, an empty `TasksService` (inject `PrismaService`), and
a `TasksController` with `@Controller({ path: 'tasks', version: '1' })` and
`@ApiTags('Tasks')` + `@ApiBearerAuth('access-token')`. Register in
`app.module.ts`. Start the app, confirm it boots.

### Step 2 — Create task (endpoint #1)
- DTO `CreateTaskDto`: `clientTaskId` (UUID, required — mobile generates it),
  `title`, `description`, `destination?`. Use `class-validator` + `@ApiProperty`
  exactly like `create-user.dto.ts`.
- Service `create(userId, dto)`: **upsert** on `clientTaskId` so a retried
  offline create doesn't make a duplicate:
  ```ts
  return this.prisma.task.upsert({
    where: { clientTaskId: dto.clientTaskId },
    update: {},                       // retry is a no-op
    create: { ...dto, officeBoyId: userId, status: 'PENDING' },
    select: TASK_SELECT,
  });
  ```
- Controller: `@Post()`, `@Roles(Role.OFFICE_BOY)`, `@CurrentUser('userId')`.
- Define a `TASK_SELECT` allowlist constant (like `PUBLIC_USER_SELECT`).

### Step 3 — List + get (endpoints #2, #3)
- List: filter by `officeBoyId = userId`, optional `status`, paginate with the
  existing `PaginationMetaDto`. Uses the `@@index([officeBoyId, status])`.
- Get one: fetch by id; if the task's `officeBoyId !== userId` **and** the caller
  isn't ADMIN, throw `ForbiddenException`. (Ownership check — don't let one
  office boy read another's task.)

### Step 4 — Start (endpoint #4)
- DTO `LocationPointDto`: `latitude`, `longitude`, `recordedAt` (ISO string).
- Service `start(userId, taskId, dto)`:
  - Load task, assert ownership, assert current status is `PENDING` (else
    `ConflictException` — "task already started"). **State transitions are
    enforced in code**, per the schema comment.
  - Update: `status: 'IN_PROGRESS'`, `startedAt: now`, `startLatitude/Longitude`.

### Step 5 — Location batch upload (endpoint #5) — the important one
- DTO: a batch wrapper `{ points: LocationBatchItemDto[] }`. Each item:
  `clientId` (required, UUID), `latitude`, `longitude`, `recordedAt`, and the
  optional quality fields (`accuracyMeters`, `speedMetersPerSecond`, `isMoving`,
  `batteryLevel`, `altitudeMeters`, `headingDegrees`). Use
  `@ValidateNested({ each: true })` + `@Type(() => Item)`.
- Cap the batch size (e.g. `@ArrayMaxSize(500)`) so one request can't be huge.
- Service `addLocations(userId, taskId, points)`:
  - Assert ownership. Accept when task is `IN_PROGRESS`, **or** `COMPLETED` but
    within the grace window (see Step 6) — then flag for recompute.
  - **Upsert each point on `clientId`** so retried batches are harmless. Use a
    transaction of upserts, or `createMany({ skipDuplicates: true })` keyed on
    the unique `clientId` (simplest and fast). Return `{ accepted: n }`.
  - This endpoint does **not** touch task status — it's decoupled.

### Step 6 — End + distance/time (endpoint #6) — the other important one
- DTO `EndTaskDto`: end `latitude`, `longitude`, `recordedAt`.
- Service `end(userId, taskId, dto)`:
  1. Assert ownership + status is `IN_PROGRESS`.
  2. Save `endLatitude/Longitude`, `endedAt: now`, `status: 'COMPLETED'`.
  3. **Compute** from `TaskLocation` rows (ordered by `recordedAt`, uses
     `@@index([taskId, recordedAt])`):
     - **Noise filter**: drop points with `accuracyMeters` above a threshold
       (e.g. > 50 m) and points where `isMoving === false`. Mark them
       `isFiltered: true` rather than deleting.
     - **Distance**: sum haversine between consecutive surviving points →
       `distanceMeters`.
     - **Duration**: `durationSeconds = (endedAt - startedAt) / 1000`.
     - **Route**: encode surviving points as a Google polyline → create/replace
       the `Route` row (`encodedPolyline`, `distanceMeters`, `pointCount`,
       `rawPointCount`).
     - Cache `distanceMeters` + `durationSeconds` back onto the `Task`.
  4. Do steps 2–3 in a **transaction** so a task is never COMPLETED without its
     computed totals.
  5. **Grace window for late points**: because a phone may flush buffered points
     seconds after end, allow `POST /locations` to still succeed for a short
     window (e.g. 10 minutes after `endedAt`), and when that happens, **re-run
     the computation** so the trail and distance include the late data. Simplest
     implementation: on a late batch, recompute inline. (A background job is
     nicer later, but inline is fine to start.)
- Put the haversine + filter logic in a **pure function** in `distance.ts` so
  you can unit-test it with fixed coordinates and no database.

### Step 7 — Cancel (endpoint #7)
- `CancelTaskDto`: `cancellationReason`. Allowed from `PENDING` or
  `IN_PROGRESS`. Sets `status: 'CANCELLED'`, `cancelledAt`, `cancellationReason`.

### Step 8 — Tests + verify
- Unit-test `distance.ts` with known coordinates (e.g. two points ~111 m apart
  ≈ 0.001° latitude). Test the noise filter drops low-accuracy points.
- Test the state machine: starting a COMPLETED task → 409; ending a PENDING
  task → 409.
- Run the full suite and lint before marking the PR ready:
  ```bash
  npm run test
  npm run lint
  npm run build
  ```

---

## Part E — Conventions to follow (from your existing code)

- **DTOs are strict.** `main.ts` uses `whitelist + forbidNonWhitelisted`, so any
  field not on the DTO is rejected. Declare every field you accept.
- **Identity from the token**, never the body: `@CurrentUser('userId')`.
- **Authorization** via `@Roles(Role.OFFICE_BOY)` at the method or controller.
- **Select allowlists** (`TASK_SELECT`) instead of returning the raw model, so
  you never accidentally leak a field.
- **State transitions enforced in code** with `ConflictException` — the schema
  comment says so explicitly.
- **Client-generated ids are idempotency keys** — always upsert on
  `clientTaskId` / `clientId`, never plain create, for anything from the device.
- **Comments explain _why_**, matching the tone of the rest of the codebase.
- Everything returns wrapped in the `{ success, data, timestamp }` envelope
  automatically (the global interceptor) — you don't do anything for that.

---

## Part F — Quick reference: request bodies for the frontend

Once built, these are what the RN app sends (all under `/api/v1`):

```
POST /tasks
{ "clientTaskId": "<uuid>", "title": "...", "description": "...", "destination": "..." }

POST /tasks/:id/start
{ "latitude": 24.86, "longitude": 67.00, "recordedAt": "2026-07-31T09:00:00.000Z" }

POST /tasks/:id/locations
{ "points": [
  { "clientId": "<uuid>", "latitude": 24.86, "longitude": 67.00,
    "accuracyMeters": 8, "speedMetersPerSecond": 1.4, "isMoving": true,
    "batteryLevel": 82, "recordedAt": "2026-07-31T09:00:10.000Z" }
] }

POST /tasks/:id/end
{ "latitude": 24.90, "longitude": 67.05, "recordedAt": "2026-07-31T10:30:00.000Z" }

POST /tasks/:id/cancel
{ "cancellationReason": "Customer not available" }
```

---

## TL;DR checklist

- [ ] `git pull main`, branch `feat/tasks-module`, open Draft PR
- [ ] Scaffold module → register in `app.module.ts`
- [ ] Create (upsert on clientTaskId) → List → Get
- [ ] Start (PENDING→IN_PROGRESS + start fix)
- [ ] Locations batch (upsert on clientId, decoupled)
- [ ] End (compute distance/duration/route in a transaction) + grace-window recompute
- [ ] Cancel
- [ ] Unit-test distance.ts + state machine; lint; build
- [ ] Mark PR ready, review, squash-merge, delete branch
