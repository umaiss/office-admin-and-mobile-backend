# Phase 0 — Foundations & Cross-Cutting Concerns

**Status: complete.** Typecheck clean · 23/23 tests passing · 0 lint errors · verified running against PostgreSQL.

---

## What we built and why

| Area | Files | What it gives us |
|---|---|---|
| **Config** | `src/config/env.schema.ts`, `env.validation.ts`, `app-config.service.ts`, `config.module.ts` | The app refuses to start on bad configuration, and reads config through typed properties |
| **Errors** | `src/common/filters/all-exceptions.filter.ts` | Every failure — ours, Prisma's, or an unhandled bug — becomes one consistent JSON shape |
| **Responses** | `src/common/interceptors/response.interceptor.ts`, `decorators/no-envelope.decorator.ts` | Every success becomes one consistent JSON shape |
| **Logging** | `src/config/logger.config.ts` | Structured JSON logs, per-request correlation ids, secrets redacted |
| **Docs** | `src/common/swagger/setup-swagger.ts` | Interactive, always-current API docs at `/api/docs` |
| **Health** | `src/health/` | Separate liveness and readiness probes for deployment platforms |
| **Bootstrap** | `src/main.ts` | helmet, compression, CORS, URI versioning, strict validation, graceful shutdown |
| **Build** | `tsconfig.json`, `package.json`, `prisma/schema.prisma` | `strict: true`, correct `dist/` layout, working `start:prod` |

---

## Key concepts, in order of importance

### 1. Fail fast

There are two ways to handle a missing `JWT_SECRET`:

- Start fine, crash at 3am when the first user logs in → a production incident.
- Refuse to start, naming the bad variable → a deployment that simply doesn't happen, with the old version still serving traffic.

`validateEnv` runs a Zod schema over `process.env` before any module is constructed. Nothing downstream needs a `?`, a `!`, or a fallback, because the value is guaranteed by the time it is read.

Try it: set `JWT_SECRET="short"` in `.env` and run `npm start`.

### 2. Cross-cutting concerns belong in the pipeline

Error formatting, response shaping, validation, and logging apply to *every* endpoint. Written once in the request pipeline, they cannot be forgotten by any future controller. Written per-controller, they drift.

This is the real reason NestJS looks heavier than Express: it gives you designated homes for the things that would otherwise be copy-pasted.

### 3. Guards vs Pipes vs Interceptors vs Filters

| Stage | Question | Ours |
|---|---|---|
| Middleware | Raw plumbing | helmet, compression, pino |
| **Guard** | May this request proceed? | `JwtAuthGuard`, `RolesGuard` |
| **Interceptor** | Transform in/out | `ResponseInterceptor` |
| **Pipe** | Is the input valid? | `ValidationPipe` |
| **Filter** | Something failed — what does the client see? | `AllExceptionsFilter` |

Ordering trap worth remembering: **guards run before pipes**, so a guard cannot assume the body has been validated.

### 4. Log what developers need; return what clients need

Stack traces, Prisma error codes, and SQL go to the logs. The client gets a status code, a safe message, and a `requestId`. In production, a 500 never echoes its underlying message — error messages are how attackers map your schema and library versions.

### 5. Type aliases don't exist at runtime — the DI trap

This was a real bug during the build, and it's worth understanding because it will happen to you again.

```ts
// Looks fine. Type-checks perfectly. Fails at runtime.
export type AppConfigService = ConfigService<Env, true>;

constructor(private readonly config: AppConfigService) {}
// → Nest can't resolve dependencies ... argument at index [1] is undefined
```

Nest resolves dependencies at runtime using metadata TypeScript emits from the parameter's type. A **class** exists at runtime, so its name is emitted. A **type alias** is erased at compile time — nothing remains — so TypeScript writes `Object` and Nest has no token to look up.

The fix was `AppConfigService` as a real `@Injectable()` class. That also gave us better ergonomics:

```ts
config.get('JWT_ACCESS_TTL_SECONDS', { infer: true })  // stringly-typed; a typo fails at runtime
config.jwtAccessTtlSeconds                              // a typo fails to compile
```

### 6. Incremental build caches must live with their output

Also a real bug hit during this phase. `npm run build` reported success and emitted **nothing**, and `node dist/main` crashed with `Cannot find module './app.controller'`.

Cause: TypeScript's `tsbuildinfo` cache sat at the project root while output went to `dist/`. Deleting `dist/` left the cache saying "everything is already compiled". Fix: `"tsBuildInfoFile": "./dist/.tsbuildinfo"` — now the cache and the output share a lifetime and cannot disagree.

The general lesson: **a cache that can outlive the thing it describes will eventually lie to you.**

### 7. Liveness ≠ readiness

- **Liveness** — "is the process alive?" Failure means *restart me*. Checks **no** dependencies.
- **Readiness** — "can it serve traffic?" Failure means *stop routing to me*. Checks the database.

Putting a database check in the liveness probe is a classic self-inflicted outage: the database blips, the platform restarts every API instance, and now nothing is running either.

### 8. URI versioning, added before clients exist

All routes are `/api/v1/...`. When a future change would break the shipped mobile app, we publish `/api/v2` alongside and let old app versions keep working. Retrofitting this after clients ship is close to impossible — old binaries are already in users' hands.

---

## Notable decisions

**Response envelope.** Success is `{ success, data, timestamp }`; failure is `{ success, statusCode, message, error, path, timestamp, requestId }`. One unwrapping path on the client, and the two shapes are siblings. Machine-facing endpoints opt out with `@NoEnvelope()` — used by the health probes.

**Durations as seconds, not `"15m"` strings.** This deleted a 30-line hand-rolled duration parser from `AuthService`. A number cannot be malformed and needs no parsing.

**`SWAGGER_ENABLED` defaults to `false`.** Docs publish a complete map of the API. Opt in per environment.

**CORS default is `false`, not `true`.** Reflecting any origin while allowing credentials lets any website on the internet make authenticated calls for a logged-in user.

**Prisma client moved to `src/generated/prisma`.** With it outside `src/`, TypeScript inferred a rootDir one level up and emitted `dist/src/main.js` — which is why `start:prod` pointed at a file that did not exist. It is excluded from lint and coverage, since it is derived code.

---

## Verify it yourself

```bash
npm run typecheck && npm test && npm run lint && npm run build && npm run start:prod
```

Then:

```bash
curl -s http://localhost:3000/health/ready
```

```bash
curl -s -X POST http://localhost:3000/api/v1/users -H "Content-Type: application/json" -d '{"email":"bad","password":"123"}'
```

The second returns a 400 listing every validation failure at once, wrapped in the standard error envelope with a `requestId`. Open <http://localhost:3000/api/docs> for the interactive documentation.

---

## Known items carried forward

- **`POST /api/v1/users` is still unauthenticated.** Anyone can create an admin. Fixed in Phase 2, once Phase 1's seed script exists to create the first admin.
- **31 npm advisories**, all transitive dev tooling (jest, eslint, nest-cli) tracing to two DoS advisories in `brace-expansion` and `js-yaml`. Nothing in the production request path. Revisit in Phase 10.
- **Two startup warnings** about the route path `/api/*` from Nest's global-prefix exclusion under Express 5. Cosmetic — Nest auto-converts the pattern and the routes work.
- **Three lint warnings** in `auth.controller.spec.ts` from `any`-typed mocks predating this phase. Tightened in Phase 9.
