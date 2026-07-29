#!/usr/bin/env bash
# =============================================================================
#  OB Track — deploy script
# =============================================================================
#  Run ON THE EC2 INSTANCE, from the project directory:
#
#      ./deploy.sh
#
#  Pulls the latest code, rebuilds the image, applies database migrations, and
#  restarts the API with zero configuration drift.
# =============================================================================

# set -euo pipefail — the four settings that make a bash script safe:
#   -e            stop at the first command that fails, instead of ploughing on
#   -u            treat an unset variable as an error, not as an empty string
#   -o pipefail   a pipeline fails if ANY stage fails, not just the last one
#
# Without -e, a failed migration would be logged and the script would happily
# restart the API against a database whose schema does not match the new code.
set -euo pipefail

cd "$(dirname "$0")"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
step() { echo -e "\n${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

# --- Preflight ---------------------------------------------------------------
# Check assumptions BEFORE changing anything. A deploy that fails at step 1 is
# an inconvenience; one that fails halfway leaves the system in a state nobody
# designed.
[ -f .env.production ] || fail ".env.production is missing. Copy .env.production.example and fill it in."

grep -q 'CHANGE_ME' .env.production && fail ".env.production still contains CHANGE_ME placeholders."

# Every compose command needs --env-file.
#
# docker-compose.yml refers to ${POSTGRES_USER}, ${DATABASE_URL} and friends.
# Compose resolves those from the shell environment or from a file literally
# named `.env` — it does NOT read `.env.production` on its own. Without this
# flag the variables silently resolve to empty strings and Postgres starts with
# no password while the API cannot connect.
COMPOSE="docker compose --env-file .env.production"

step "Fetching latest code"
git pull --ff-only

step "Building images"
# Built before anything is stopped: if the build fails, the running version is
# untouched and users never notice.
$COMPOSE build

step "Applying database migrations"
# `migrate deploy` — NOT `migrate dev`. `dev` is interactive and can reset the
# database when it detects drift. Running it against production data is one of
# the classic ways to destroy a database.
$COMPOSE run --rm migrate

step "Restarting services"
$COMPOSE up -d --remove-orphans

step "Waiting for the API to report healthy"
for i in $(seq 1 30); do
  if curl -fsS http://localhost/health/ready > /dev/null 2>&1; then
    echo -e "${GREEN}✓ API is ready${NC}"
    break
  fi
  [ "$i" -eq 30 ] && {
    warn "API did not become ready within 60s. Recent logs:"
    $COMPOSE logs --tail=50 api
    fail "Deploy failed."
  }
  sleep 2
done

step "Cleaning up old images"
# Untagged images left by previous builds. Skipping this is how a small
# instance silently runs out of disk after a few weeks of deploys.
docker image prune -f > /dev/null

step "Done"
$COMPOSE ps
echo
echo "Health:  curl http://localhost/health/ready"
echo "Logs:    docker compose --env-file .env.production logs -f api"
