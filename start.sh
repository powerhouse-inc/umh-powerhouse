#!/usr/bin/env bash
# UMH Powerhouse demo — one command to bring up Paperless + Powerhouse +
# the simulated factory, wired together. Pattern follows
# powerhouse-inc/paperless-billing's start.sh.
set -euo pipefail
cd "$(dirname "$0")"

# Compose reads .env itself, but this script also probes URLs that follow the
# same variables — source it so a custom port is honoured on both sides.
if [ -f .env ]; then set -a; . ./.env; set +a; fi

CONNECT_PORT="${CONNECT_HOST_PORT:-3000}"
SWITCHBOARD_PORT="${SWITCHBOARD_HOST_PORT:-4001}"
PAPERLESS_PORT="${PAPERLESS_HOST_PORT:-8000}"
DRIVE_URL="http://localhost:${CONNECT_PORT}/?driveUrl=http://localhost:${SWITCHBOARD_PORT}/d/pl-dashboard"

say() { printf '%b\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
command -v curl >/dev/null || die "curl is required"

if [ ! -f .env ]; then
  cp .env.example .env
  die ".env created from .env.example — fill in PAPERLESS_AI_API_KEY and UMH_LEDGER_VERSION, then re-run"
fi
grep -q '^PAPERLESS_AI_API_KEY=..' .env || die "PAPERLESS_AI_API_KEY is empty in .env"
grep -q '^UMH_LEDGER_VERSION=..' .env || die "UMH_LEDGER_VERSION is empty in .env"

# A standalone umh-factory deployment holds the same host ports.
if docker ps --format '{{.Names}}' | grep -q '^umh-factory-'; then
  die "a standalone umh-factory stack is running and holds ports 80/8081/502/4840+. Stop it first: (cd ~/umh-factory && docker compose stop)"
fi

mkdir -p .local/consume

# umh-core runs as uid 1000 and must own its /data dir; docker would otherwise
# auto-create it root-owned and the container crash-loops with
# "Cannot write to /data directory". (The upstream installer's builder does
# this same chown.)
docker run --rm -v "$PWD:/w" alpine sh -c "mkdir -p /w/umh-core-data /w/simulator-data && chown -R 1000:1000 /w/umh-core-data" >/dev/null

# ── Up ──────────────────────────────────────────────────────────────────────
say "Starting the stack (first run pulls ~3 GB and installs the ledger package — be patient)..."
# `up` is retried because a dependency that CRASHES on start — rather than
# being merely slow — aborts the whole run: compose stops waiting on
# `condition: service_healthy` and leaves every dependent in Created, a state no
# restart policy will ever move (those only apply once a container has run and
# exited). On Apple Silicon the amd64 switchboard image is emulated and Rosetta
# intermittently miscompiles V8's JIT output ("rosetta error: target for 19-bit
# branch is out-of-range"), killing the first start a second or two in;
# `restart: unless-stopped` has it back within seconds. The stack is fine — it
# just needs a second `up` to start what got skipped, which is precisely what a
# human does by re-running this script. Do that for them.
UP_ATTEMPTS=3
for attempt in $(seq 1 "$UP_ATTEMPTS"); do
  docker compose up -d 2>/tmp/umh-powerhouse-up.err && break

  # A taken host port is never transient.
  grep -qi "ports are not available" /tmp/umh-powerhouse-up.err && \
    die "a host port is taken — see /tmp/umh-powerhouse-up.err ($(grep -o 'address already in use[^"]*' /tmp/umh-powerhouse-up.err | head -1))"

  # Anything that is not a dependency-start failure is a genuine error.
  grep -qiE 'dependency failed to start|is unhealthy' /tmp/umh-powerhouse-up.err || {
    cat /tmp/umh-powerhouse-up.err >&2; exit 1
  }

  if [ "$attempt" -eq "$UP_ATTEMPTS" ]; then
    cat /tmp/umh-powerhouse-up.err >&2
    die "a dependency failed to start on $UP_ATTEMPTS successive attempts, so this is not the transient emulation crash. Try: docker compose logs switchboard"
  fi

  say "  a dependency crashed on start (attempt $attempt/$UP_ATTEMPTS); its restart policy is bringing it back — retrying in 15s..."
  sleep 15
done

# ── Wait ────────────────────────────────────────────────────────────────────
say "Waiting for services to become healthy (up to 15 minutes on first run)..."
DEADLINE=$(( $(date +%s) + 900 ))
while :; do
  unhealthy=""
  for svc in broker webserver switchboard connect machine-simulator timescaledb pgbouncer; do
    state=$(docker compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' | grep "^${svc}|" || true)
    [ -z "$state" ] && { unhealthy="$svc(missing)"; break; }
    case "$state" in
      *"|running|healthy") ;;
      *"|running|") ;; # services without healthchecks (umh-core, nginx)
      *) unhealthy="$svc(${state#*|})";;
    esac
    [ -n "$unhealthy" ] && break
  done
  boot_state=$(docker compose ps -a --format '{{.Service}}|{{.State}}' | grep '^bootstrap|' | cut -d'|' -f2)
  if [ -z "$unhealthy" ] && [ "$boot_state" = "exited" ]; then break; fi
  [ "$(date +%s)" -ge "$DEADLINE" ] && die "timed out waiting (last pending: ${unhealthy:-bootstrap}). Try: docker compose logs switchboard"
  sleep 10
done

# Bootstrap must have SUCCEEDED, not merely finished.
code=$(docker inspect "$(docker compose ps -aq bootstrap)" --format '{{.State.ExitCode}}')
[ "$code" = "0" ] || { docker compose logs bootstrap | tail -20; die "bootstrap exited with code $code"; }

# ── Post-condition: the ledger package actually composed into the supergraph ─
schema=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { types { name } } }"}' \
  "http://localhost:${SWITCHBOARD_PORT}/graphql")
echo "$schema" | grep -q "ProductionLedger" || \
  die "the ledger package did not compose into the supergraph. Check: docker compose logs switchboard | grep -iE 'package|subgraph'"

open_url() {
  case "$(uname -s)" in
    Darwin) open "$1" ;;
    *) if grep -qi microsoft /proc/version 2>/dev/null; then
         command -v wslview >/dev/null && wslview "$1" || powershell.exe -NoProfile Start-Process "'$1'" 2>/dev/null || true
       else
         xdg-open "$1" >/dev/null 2>&1 || true
       fi ;;
  esac
}
open_url "http://localhost:${PAPERLESS_PORT}"
open_url "http://localhost:8081"
open_url "$DRIVE_URL"

cat <<SUMMARY

  UMH Powerhouse demo is up.

    Paperless   http://localhost:${PAPERLESS_PORT}   (admin / paperless)
    Connect     ${DRIVE_URL}
    Reactor     http://localhost:${SWITCHBOARD_PORT}/graphql
    Simulator   http://localhost:8081
    Gateway     http://localhost:80   (stop-reason + costs APIs)

  Try it: drop a purchase-order PDF (word "order" in the text) into
  .local/consume/ or upload it in Paperless. After OCR + extraction it
  appears in the PL Dashboard drive as a DRAFT ledger with the scan
  attached. Review, approve (creates the floor order), open the ledger,
  and watch the evidence trail fill from the machines.

    docker compose logs -f switchboard   # ingestion + floor poller
    docker compose down                  # stop   (-v wipes everything)
    docker compose run --rm bootstrap    # re-run wiring
SUMMARY
