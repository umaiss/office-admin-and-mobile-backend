# Phase 1 — Database Schema, Round Two

**Status: complete.** Migration applied · seed idempotent · typecheck clean · 23/23 tests · 0 lint errors · seeded accounts verified logging in.

---

## The decision that opened the phase

The roadmap flagged a choice: reset the database for a clean migration history, or add an incremental migration.

I checked the database rather than guessing:

| Table | Rows |
|---|---|
| User | 2 (`ali@company.com`, `jawad@company.com`) |
| Task, TaskLocation, Notification | 0 |
| RefreshToken | 1 |

Every table needing a **breaking** change (`Task`, `TaskLocation`) was empty, so an incremental migration destroys nothing. The only change to the populated `User` table is an additive nullable column. Reset would have bought slightly tidier history at the cost of deleting real accounts — a bad trade.

> **The principle:** check the blast radius before choosing a destructive option. "Clean history" is a preference; "don't delete the user's data" is a requirement.

---

## What changed in the schema

### New models

**`Route`** — the computed path of a finished task, stored as an encoded polyline. Kept out of `Task` so a task list query never drags a 12KB polyline along with it.

**`Attendance`** — check-in/check-out with location, one record per person per day. The important line in it:

```prisma
@@unique([userId, date])
```

That constraint lives in the **database**, not in application code, because two simultaneous check-in requests can both pass an application-level "does a record already exist?" check and both insert. Only a unique constraint makes the race impossible.

### Offline-sync idempotency — the reason this phase preceded Phase 5

`TaskLocation.clientId` is a **required** unique key generated on the device.

Without it:

1. Phone uploads 50 GPS points.
2. Server saves all 50.
3. Response is lost — lift, tunnel, dead battery.
4. Phone assumes failure and re-uploads the same 50.
5. Server now holds 100 rows for 50 real positions.

The office boy's report reads 12km instead of 6km. With the key, the server upserts and the retry is harmless.

`Task.clientTaskId` does the same for tasks created while offline — nullable, because tasks created from the admin dashboard are online by definition.

> **Concept: idempotency.** An operation is idempotent if doing it twice has the same effect as doing it once. On mobile networks retries are not an edge case, they are the norm — so this has to be designed into the schema, not patched on later. That is precisely why the schema came before the sync endpoint.

### Device time vs server time

```prisma
recordedAt DateTime              // when the DEVICE captured it — required
receivedAt DateTime @default(now())  // when the SERVER got it
```

With offline sync these differ by hours. Keeping both is what distinguishes "the office boy stood still" from "the phone had no signal". And since device clocks can be wrong or deliberately changed, anything trustworthy is measured from `receivedAt`.

### GPS quality signals

`accuracyMeters`, `speedMetersPerSecond`, `headingDegrees`, `altitudeMeters`, `isMoving`, `batteryLevel` — the inputs the Phase 5 noise filter needs. Plus `isFiltered`, marking points excluded from the distance total.

We **keep** filtered rows rather than deleting them, so that a bug in the filter can be corrected and totals recomputed from the original data. Deleting data because your current code doesn't want it is a decision you cannot undo.

### Units in names

`distance` → `distanceMeters`. `duration` → `durationSeconds`. `accuracy` → `accuracyMeters`.

A field called `distance` will eventually be read as kilometres by someone writing the dashboard, and the bug will be silent. The name is the documentation.

### Cascade rules

Previously every foreign key was `Restrict` (the default), meaning deleting a task was *blocked* by its own location rows. Now:

| Relation | Rule | Why |
|---|---|---|
| `TaskLocation` → `Task` | Cascade | Locations are meaningless without their task |
| `Route` → `Task` | Cascade | Same |
| `RefreshToken` → `User` | Cascade | Sessions die with the account |
| `Notification` → `User` | Cascade | |
| `Notification` → `Task` | **SetNull** | The notification survives as history; it just stops linking |
| `Task` → `User` | **Restrict** | Deleting someone with 400 tasks must fail loudly, not erase history |

### Indexes

Dropped the redundant `@@index([email])` — `@unique` already creates one, and a duplicate costs write performance for nothing.

Added composites that match queries Phases 3–8 will actually run:

```prisma
@@index([officeBoyId, status])     // mobile home screen, live activity panel
@@index([officeBoyId, createdAt])  // every per-person report
@@index([status, createdAt])       // dashboard KPI counts
@@index([taskId, recordedAt])      // distance calculation, route rendering
@@index([userId, isRead])          // unread notification badge
```

> **Concept: indexes are not free.** Each one is a data structure the database maintains on every insert and update. Add them for queries you will actually run, in the column order those queries filter by — not "just in case".

---

## The seed script

[prisma/seed.ts](../prisma/seed.ts) resolves the chicken-and-egg problem that has kept `POST /users` open: only an admin can create users, but the first admin has to come from somewhere.

```bash
npm run prisma:seed
```

Three properties worth noting:

**Idempotent.** Every write checks first and leaves existing rows untouched. Verified by running it twice — the second run reported `already exists (unchanged)` for all three accounts and your two original users were never touched.

**Refuses to create a backdoor.** With `NODE_ENV=production`, `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` are required and the password must be ≥12 characters. A seed script with a well-known default password *is* a backdoor, so it throws rather than create one. Sample office boys are skipped in production entirely — seeded test accounts becoming real production logins is a genuine incident pattern.

**Does not reset passwords on re-run.** A seed that silently overwrites a changed admin password would be a nasty surprise in a shared environment.

### Seeded accounts (development)

| Email | Password | Role |
|---|---|---|
| `admin@obtrack.local` | `ChangeMe123!` | ADMIN |
| `bilal@obtrack.local` | `Password123!` | OFFICE_BOY |
| `usman@obtrack.local` | `Password123!` | OFFICE_BOY |

Both verified logging in against the running server.

---

## Two bugs caught during this phase

### 1. `??` does not catch empty strings

The seed read config like this:

```ts
const email = process.env.SEED_ADMIN_EMAIL ?? DEV_DEFAULTS.email;
```

`.env` files routinely contain `SEED_ADMIN_EMAIL=""` as a placeholder — and `??` only falls back on `null`/`undefined`. An empty string is neither, so this would have created a user with an empty email. Fixed with an `optionalEnv()` helper that treats blank as unset.

Anything reading optional config from `process.env` needs this distinction.

### 2. Tests were passing without being type-checked

`npm test` was green while the specs contained four genuine type errors — `mockUser` was missing the new `lastLoginAt` field.

Cause: `isolatedModules: true` in `tsconfig.json` puts ts-jest into **transpile-only** mode. It strips types and runs, never checking them. And `npm run typecheck` used `tsconfig.build.json`, which *excludes* `**/*spec.ts`. So nothing in the pipeline was checking test files at all.

Fixed by making typecheck cover both:

```json
"typecheck": "tsc --noEmit -p tsconfig.build.json && tsc --noEmit -p test/tsconfig.json"
```

> **The general lesson:** a quality gate that never fails is not protecting you — it is lying to you. When you add a gate, prove it catches something before trusting it.

---

## Non-interactive migration workflow

`prisma migrate dev` requires an interactive terminal and could not run here. The workflow used instead is exactly what a CI pipeline does:

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o prisma/migrations/<timestamp>_<name>/migration.sql
npx prisma migrate deploy
```

Worth knowing regardless of interactivity: **`migrate dev` must never run against production.** It can reset and re-apply the whole history. `migrate deploy` only applies pending migrations forward, which is why it is the deployment command.

---

## Deferred deliberately

- **`Task.createdById`** (which admin assigned a task) — adding a nullable FK later is one of the *cheap* migrations, so there is no benefit to guessing now.
- **`User.employeeCode`** — same reasoning.
- **snake_case table names** — Postgres convention, but renaming every table for cosmetics is not worth a migration.

---

## Verify it yourself

```bash
npm run typecheck && npm test && npm run lint && npx prisma migrate status
```

```bash
npm run prisma:studio
```

Studio opens a browser UI over the database — the fastest way to see the new tables, columns, and relations.
