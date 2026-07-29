# =============================================================================
#  OB Track API — production image
# =============================================================================
#  A MULTI-STAGE build. The image that ships contains only what is needed to
#  RUN the app — not the TypeScript compiler, not the test suite, not the source
#  code. Smaller image, faster deploys, and a smaller attack surface: a
#  vulnerability in a build tool cannot be exploited in a container that does
#  not contain it.
#
#  Why bookworm-slim rather than alpine:
#  `bcrypt` is a native C++ addon. Alpine uses musl libc, for which bcrypt ships
#  no prebuilt binary, so it must be compiled from source at install time —
#  which needs python3, make and g++ in the image. Debian slim uses glibc, has
#  prebuilt binaries, and installs in seconds.
#
#  Stage map:
#    base       Debian + Node + OpenSSL, shared by everything below
#    builder    full dependency tree (INCLUDING dev) + compiled dist/
#               → also used at run time by the `migrate` compose service,
#                 which needs the Prisma CLI and ts-node
#    prod-deps  builder with dev dependencies pruned away
#    runtime    base + prod-deps' node_modules + builder's dist/  ← what ships
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 0: base
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base

# Prisma probes for OpenSSL at startup and warns loudly when it cannot find it.
# bookworm-slim omits it to save space. Installing it removes the warning and
# guarantees TLS works if you later point DATABASE_URL at a managed database
# such as RDS, which requires an encrypted connection.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  # Deleting the package lists in the SAME layer matters: Docker layers are
  # immutable, so removing these in a later RUN would leave them in the image
  # anyway, just hidden.
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# -----------------------------------------------------------------------------
# Stage 1: builder — full dependency tree, Prisma client, compiled TypeScript
# -----------------------------------------------------------------------------
FROM base AS builder

# Copy manifests FIRST, before the source.
#
# Docker caches each layer and reuses it while its inputs are unchanged. Since
# package.json changes far less often than source files, this ordering means an
# ordinary code change reuses the cached `npm ci` layer instead of reinstalling
# every dependency — minutes saved on every deploy.
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# `npm ci` (not `npm install`): installs exactly what package-lock.json pins and
# FAILS if the lockfile is out of step with package.json. That strictness is the
# point — the server gets byte-for-byte the dependency tree you tested against.
# `postinstall` runs `prisma generate` here, which is why prisma/ is copied above.
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src/

RUN npm run build

# NOTE: no `npm prune` in this stage.
#
# The `migrate` service in docker-compose.yml runs from this stage and needs the
# Prisma CLI and ts-node to apply migrations and run the seed script. Pruning
# here would strip both, and the seed would fail with `spawn ts-node ENOENT`.

# -----------------------------------------------------------------------------
# Stage 2: prod-deps — the dependency tree the runtime actually needs
# -----------------------------------------------------------------------------
FROM builder AS prod-deps

# Drops dev dependencies in place. The generated Prisma client lives in dist/,
# so it is unaffected.
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Stage 3: runtime — what ships
# -----------------------------------------------------------------------------
FROM base AS runtime

# NODE_ENV=production makes Express skip debug bookkeeping and libraries take
# their optimised paths. It is also read by our own config validation.
ENV NODE_ENV=production

WORKDIR /app

# Run as a non-root user.
#
# If someone finds a remote-code-execution bug in the app, this is what stands
# between "they can run code as a limited user inside one container" and "they
# are root". The node image ships an unprivileged `node` user for exactly this.
USER node

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=builder   /app/dist         ./dist
COPY --chown=node:node --from=builder   /app/package.json ./

EXPOSE 3000

# Lets Docker restart the container if the app wedges — a process can be alive
# while being unable to serve requests. Node 22 has a global fetch, so this
# needs no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form (a JSON array), NOT `CMD node dist/main`.
#
# The shell form wraps the process in /bin/sh, which does not forward signals.
# Docker's SIGTERM on deploy would then never reach Node, `enableShutdownHooks`
# would never run, and after 10 seconds Docker would SIGKILL the container —
# dropping in-flight requests and leaving database connections hanging.
CMD ["node", "dist/main"]
