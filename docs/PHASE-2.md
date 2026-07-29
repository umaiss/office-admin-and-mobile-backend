# Phase 2 — Authentication Hardening & RBAC

**Status: complete.** Typecheck clean · 43/43 tests (up from 23) · 0 lint errors · every control verified live against a running server.

---

## Token lifetimes: the decision and its consequence

Configured as requested:

| Token | Lifetime | Revocable? |
|---|---|---|
| Access (JWT) | **7 days** | No — stateless |
| Refresh | **30 days** | Yes — stored, rotated, revocable |

A JWT carries its own validity in its signature. The server keeps no record of it, so there is nothing to delete: **it stays valid until it expires, full stop.** Its lifetime is therefore the maximum window during which a stolen token keeps working. The conventional value is 900 seconds.

At 7 days, the usual "the gap is small enough to ignore" argument stops holding. So the design changed to compensate:

**`JwtStrategy` now queries the database on every authenticated request.**

That is not the textbook JWT design — the whole appeal of a stateless token is needing no lookup. We trade one indexed primary-key lookup per request for **immediate revocation**: deactivating an account takes effect on the user's very next request instead of up to a week later. The role is also read from the database rather than the token, so demoting an admin applies instantly and a token minted while they were an admin cannot be replayed for admin powers.

> **The transferable idea:** a decision in one place (token lifetime) changes what is *correct* somewhere else entirely (whether to verify against the database). Design decisions are not independent — changing one moves the constraints on others.

Both values are config-driven. Shortening `JWT_ACCESS_TTL_SECONDS` to `900` is a one-line `.env` edit; the database check would then become an optional optimisation rather than a necessity.

---

## What was fixed

| Problem | Fix | Verified |
|---|---|---|
| `POST /users` had no guard — anyone could create an ADMIN | Global auth + `@Roles(ADMIN)` | 401 anonymous · 403 as office boy · 201 as admin |
| Refresh tokens never rotated | Rotation on every use | Old token dies, new one issued |
| No theft detection | Reuse detection revokes the session family | Replay → all sessions killed, warning logged |
| O(n) bcrypt scan per refresh | `<rowId>.<secret>` + SHA-256 → one lookup, one compare | — |
| `isActive` ignored entirely | Enforced at login, refresh, **and every request** | Deactivate → same token 401s immediately |
| Logout killed every device | Per-device revocation | Phone out, dashboard unaffected |
| No rate limiting | 5 attempts/60s on auth, 120/60s elsewhere | 429 after the limit |
| `userId` supplied in the refresh body | Derived from the stored token | — |
| Weak password rules | 8–72 chars, mixed case + digit | — |

---

## Key concepts

### 1. Fail closed — the global guard

`JwtAuthGuard` is now registered as an `APP_GUARD`, so **every endpoint requires a valid token by default**. Routes opt out with `@Public()`.

The inversion matters more than it looks:

- **Per-route guards:** forgetting `@UseGuards()` leaves an endpoint publicly exposed. Silent, looks like working code, invisible in review.
- **Global guard:** forgetting `@Public()` returns 401. Loud, caught the first time anyone calls it.

Design so that a mistake denies access rather than granting it.

### 2. Guard execution order

```
ThrottlerGuard  →  JwtAuthGuard  →  RolesGuard
```

Not arbitrary. Throttling runs first so a brute-force run is rejected *before* it costs a bcrypt comparison — put it after authentication and every attempt still burns CPU. `RolesGuard` runs last because it reads `request.user`, which only exists because `JwtAuthGuard` put it there.

### 3. Authentication vs authorisation

Two separate guards for two separate questions:

- **Authentication** — *who are you?* (`JwtAuthGuard`)
- **Authorisation** — *may you do this?* (`RolesGuard`)

Conflating them is a common source of access-control bugs. Note also that RBAC alone is not enough: "office boys may view tasks" does not say "office boy A may not view office boy B's tasks". That second check — **ownership** — arrives in Phase 4.

### 4. Match the hash to the secret's entropy

bcrypt is deliberately slow. That is exactly right for a *password*, which is low-entropy and guessable, so each guess must be made expensive.

A refresh token secret is 32 bytes from a CSPRNG — 256 bits. There is no dictionary and no feasible brute force, so slowness buys nothing and costs latency on every refresh. SHA-256 with `timingSafeEqual` is the correct tool.

Reaching for bcrypt reflexively is a mistake; choose the hash to fit the secret.

### 5. Rotation plus reuse detection

Every refresh issues a new token and revokes the old one. Revoked rows are **marked, not deleted**, so a replayed token is still recognisable.

If a rotated token is presented again with the correct secret, two parties hold it — the user and a thief — and there is no way to tell which is calling. The only safe response is to revoke the entire session family and force a fresh login.

The order of checks matters: the secret is verified **before** a revoked row is treated as theft. Otherwise anyone who learned a token id from a log file could force a logout for that user, turning a security feature into a denial-of-service lever.

### 6. Don't leak which accounts exist

Login returns the same message for "no such email" and "wrong password", and still runs a hash comparison when the user is absent — otherwise a missing account returns measurably faster, and timing alone reveals which addresses have accounts.

Similarly, every refresh failure returns the same message. A caller has no legitimate need to know whether their token was expired, unknown, or flagged as stolen.

---

## The bug that only live testing found

Unit tests were green. Then this appeared in live verification:

```
logout the phone       → 200
phone refresh          → 401  ✓ expected
DASHBOARD refresh      → 401  ✗ should have been 200
```

Every one of the user's tokens had been revoked at the same instant.

**Cause.** Logout sets `revokedAt`. Rotation *also* sets `revokedAt`. So when the phone made one stale refresh attempt after logging out, `rotate` saw a revoked token and concluded **theft** — killing every session on every device.

Real-world impact: a mobile app whose background sync retries once after logout signs the user out everywhere. Users would report it as "the app randomly logs me out" and it would be near-impossible to reproduce deliberately.

**Fix.** `replacedByTokenId` is the discriminator — it is set only by rotation:

- revoked **with** a replacement → superseded, yet someone still holds a working copy → theft
- revoked **without** a replacement → an explicit logout or admin action → just refuse it

A new `REVOKED` outcome was added alongside `REUSED`, plus a regression test.

> **Why the unit tests missed it:** they tested rotation and logout as separate scenarios. The bug lived in the *interaction* between them — logout followed by a refresh attempt. Unit tests verify units; some bugs only exist between them. That is what integration and live testing are for, and it is why "43 tests pass" is not the same as "it works".

---

## Verify it yourself

```bash
npm run build && npm run start:prod
```

Anonymous access to a protected route (expect 401):

```bash
curl -i -X POST http://localhost:3000/api/v1/users -H "Content-Type: application/json" -d '{"name":"X","email":"x@y.com","password":"Password123","role":"ADMIN"}'
```

Brute-force protection — the 6th call within a minute returns 429:

```bash
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/v1/auth/login -H "Content-Type: application/json" -d '{"email":"admin@obtrack.local","password":"wrong"}'; done
```

---

## Carried forward

- **`GET /users/:id` returns `null` for an unknown id instead of 404.** Proper CRUD semantics, pagination, and ownership checks are Phase 3's job.
- **Rate limiting is in-memory**, so it resets on restart and is per-instance. Fine for one server; Phase 10 should move it to Redis if you run more than one.
- **`ipAddress` records `::1` locally.** Behind a proxy in production you must enable `trust proxy`, or every request will appear to come from the load balancer — and rate limiting will then throttle all users as one. Phase 10.
- **`logout-all` requires a valid access token.** A user whose access token has already expired cannot use it. Adding a refresh-token-based variant is a small Phase 3 addition if you want it.
