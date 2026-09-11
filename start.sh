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

OS="$(uname -s)"
IS_WSL=0
if [ "$OS" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi

say() { printf '%b\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

# ── Preflight ───────────────────────────────────────────────────────────────
# Platform-aware: a one-line "install docker" pointed everyone at the Linux
# engine page -- unhelpful on a Mac, where the answer is a desktop runtime and
# the vmnetd false positive is the usual reason the daemon will not start.
if ! command -v docker >/dev/null 2>&1; then
  printf '\nERROR: Docker is not installed.\n\n' >&2
  if [ "$OS" = "Darwin" ]; then
    cat >&2 <<'EOF'
On macOS, install OrbStack (recommended):

  brew install --cask orbstack && open -a OrbStack

It provides docker and Compose v2, and it needs no privileged helper -- so it
cannot hit the macOS "Malware Blocked / com.docker.vmnetd" false positive that
leaves Docker Desktop unable to start.

Docker Desktop also works:

  brew install --cask docker-desktop && open -a Docker
EOF
    cat >&2 <<'EOF'

OrbStack is free for personal use; commercial use needs a paid licence.
EOF
  elif [ "$IS_WSL" = 1 ]; then
    cat >&2 <<'EOF'
In WSL2, install Docker Desktop on Windows, then enable integration for this
distro: Settings -> Resources -> WSL Integration.
https://www.docker.com/products/docker-desktop/
EOF
  else
    cat >&2 <<'EOF'
Install Docker Engine and the Compose v2 plugin:
  https://docs.docker.com/engine/install/
EOF
  fi
  exit 1
fi

# The docker CLI in a Docker Desktop WSL distro is a symlink into an iso9660
# mount served from the Docker Desktop VM. If Docker Desktop restarts while
# this distro still holds that mount, the symlink survives but every read fails
# with EIO: the binary is present and unusable, and the daemon check below
# would blame the daemon. Name the real cause instead.
if ! docker --version >/dev/null 2>&1; then
  echo "The 'docker' command exists but cannot be executed."
  echo "Reading it: $(docker --version 2>&1 | head -1)"
  echo
  if [ "$IS_WSL" = 1 ]; then
    echo "This is the usual WSL symptom of a stale Docker Desktop integration"
    echo "mount (an 'Input/output error' on /usr/bin/docker). Docker Desktop can"
    echo "be running perfectly on Windows and this still happens."
    echo
    echo "Fix, least disruptive first:"
    echo "  1. Docker Desktop -> Settings -> Resources -> WSL Integration:"
    echo "     toggle this distro OFF, Apply, then ON, Apply."
    echo "  2. If that does not help, from Windows PowerShell:  wsl --shutdown"
    echo "     then open a new terminal."
  else
    echo "Reinstall or repair the Docker CLI."
  fi
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf '\nERROR: Docker is installed but the daemon is not running.\n\n' >&2
  if [ "$OS" = "Darwin" ]; then
    cat >&2 <<'EOF'
Start your runtime and wait for it to report ready:

  OrbStack        open -a OrbStack
  Docker Desktop  open -a Docker

If Docker Desktop never becomes ready, look for a macOS "Malware Blocked"
dialog naming com.docker.vmnetd. It is a false positive -- the helper is
validly signed and notarized by Docker Inc, but XProtect blocks it and the
daemon then never starts. Leftover helpers from an older Docker install make
this much more likely. Clear them and relaunch:

  sudo launchctl bootout system/com.docker.vmnetd
  sudo launchctl bootout system/com.docker.socket
  sudo rm -f /Library/PrivilegedHelperTools/com.docker.vmnetd \
             /Library/PrivilegedHelperTools/com.docker.socket \
             /Library/LaunchDaemons/com.docker.vmnetd.plist \
             /Library/LaunchDaemons/com.docker.socket.plist

Or switch to OrbStack, which installs no privileged helper and so cannot hit
this at all.
EOF
  elif [ "$IS_WSL" = 1 ]; then
    echo "Start Docker Desktop on Windows, then re-run this script." >&2
  else
    echo "Start it with:  sudo systemctl start docker" >&2
  fi
  exit 1
fi
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

# ── Pull ────────────────────────────────────────────────────────────────────
# Streamed, not captured. Downloading the images is the slow part of a first
# run, and watching it is the difference between "it is working" and "it hung".
# A warm run just verifies the pinned tags and moves on; `up` below then only
# creates and starts containers, which is quick.
say "==> Pulling images (the very first run downloads ~3 GB)..."
docker compose pull

# ── Up ──────────────────────────────────────────────────────────────────────
# Long-running services only, --no-deps: bootstrap is a one-shot whose
# depends_on would otherwise block `up` with no output until Paperless and the
# reactor are healthy -- which reads as a hang while Docker already shows the
# other containers. Start the services, narrate health ourselves, then run
# bootstrap once they are actually up.
# `2>&1 | tee` keeps compose's own create/start lines on screen while still
# writing them to a file for the error checks below (pipefail keeps the exit
# status).
say "==> Starting the stack..."
if ! docker compose up -d --no-deps \
     broker webserver switchboard connect \
     machine-simulator umh-core timescaledb pgbouncer nginx 2>&1 | tee /tmp/umh-powerhouse-up.err; then
  if grep -qi "ports are not available" /tmp/umh-powerhouse-up.err; then
    cat >&2 <<EOF

A host port is already taken. Docker's message is opaque, so in detail:

  paperless $PAPERLESS_PORT   reactor $SWITCHBOARD_PORT   connect $CONNECT_PORT
  plus the factory ports 80, 8081, 502, 4840-4852, 5432, 8090

On WSL2 the process holding it is often on the WINDOWS side, where 'ss' and
'lsof' inside WSL cannot see it. Check from Windows:

  powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $SWITCHBOARD_PORT | Select-Object LocalPort,OwningProcess"

Then either stop that process, or pick another port in .env.
EOF
  fi
  exit 1
fi

# ── Wait ────────────────────────────────────────────────────────────────────
svc_label() {
  case "$1" in
    broker) printf 'Redis' ;;
    webserver) printf 'Paperless' ;;
    switchboard) printf 'reactor' ;;
    connect) printf 'Connect' ;;
    machine-simulator) printf 'simulator' ;;
    timescaledb) printf 'TimescaleDB' ;;
    pgbouncer) printf 'pgbouncer' ;;
    umh-core) printf 'umh-core' ;;
    nginx) printf 'nginx' ;;
    *) printf '%s' "$1" ;;
  esac
}

# First line only; never fail the script on SIGPIPE if compose prints extra.
ps_state_health() {
  local out
  out=$(docker compose ps -a --format '{{.State}}|{{.Health}}' "$1" 2>/dev/null || true)
  printf '%s' "${out%%$'\n'*}"
}

say "==> Waiting for services to become healthy (usually about a minute)..."
DEADLINE=$(( $(date +%s) + 900 ))
wait_started=$(date +%s)
last_report=0
while :; do
  pending=""
  missing=""
  for svc in broker webserver switchboard connect machine-simulator umh-core timescaledb pgbouncer nginx; do
    line=$(ps_state_health "$svc")
    if [ -z "$line" ]; then
      missing="$missing $(svc_label "$svc")"
      continue
    fi
    # "running|healthy" is healthy; "running|" is a service with no healthcheck
    # (umh-core, nginx). "running|starting" -- and created/exited -- is pending.
    case "$line" in
      'running|healthy' | 'running|') ;;
      *) pending="$pending $(svc_label "$svc")" ;;
    esac
  done

  if [ -n "$missing" ]; then
    die "these services have no container:$missing — 'docker compose up -d' did not create them. Check: docker compose ps -a"
  fi

  [ -z "$pending" ] && break

  now=$(date +%s)
  [ "$now" -ge "$DEADLINE" ] && \
    die "still not healthy after 15 minutes (waiting on:$pending). Check: docker compose logs --tail=50"

  elapsed=$(( now - wait_started ))
  if [ $(( elapsed - last_report )) -ge 15 ]; then
    say "  ${elapsed}s  waiting for:$pending to become healthy"
    last_report=$elapsed
  fi

  sleep 5
done
say "==> Paperless, reactor, Connect, and the factory floor are healthy"

# ── Wire Paperless to the reactor ────────────────────────────────────────────
# Run only now that deps are healthy. `run --no-deps` starts immediately and
# streams the bootstrap logs; `up -d` would recreate the Created/exited one-shot
# and wait without output. --rm so a leftover container cannot mask a new run.
# Skip when the sync document already exists: re-running createDocument is not
# fully idempotent. After `down -v` the reactor is empty and the probe is 0, so
# a fresh start still wires.
wired=$(curl -sS --max-time 15 -X POST -H 'content-type: application/json' \
  -d '{"query":"{ PaperlessSync { documents { totalCount } } }"}' \
  "http://localhost:${SWITCHBOARD_PORT}/graphql" 2>/dev/null || true)
if printf '%s' "$wired" | grep -Eq '"totalCount": *[1-9]'; then
  say "==> Wiring already present, skipping bootstrap"
else
  say "==> Wiring Paperless to the reactor"
  set +e
  if command -v timeout >/dev/null 2>&1; then
    timeout --foreground 600 docker compose run --rm --no-deps bootstrap
    code=$?
  else
    docker compose run --rm --no-deps bootstrap
    code=$?
  fi
  set -e
  if [ "$code" -eq 124 ]; then
    die "bootstrap did not finish within 10 minutes. Check: docker compose logs --tail=50 webserver switchboard"
  fi
  if [ "$code" != "0" ]; then
    die "the Paperless <-> reactor wiring failed (bootstrap exit $code). Check: docker compose logs bootstrap"
  fi
  say "==> Wiring complete"
fi

# ── Post-condition: the ledger package actually composed into the supergraph ──
schema=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { types { name } } }"}' \
  "http://localhost:${SWITCHBOARD_PORT}/graphql")
echo "$schema" | grep -q "ProductionLedger" || \
  die "the ledger package did not compose into the supergraph. Check: docker compose logs switchboard | grep -iE 'package|subgraph'"

# ── Browser ─────────────────────────────────────────────────────────────────
# Background the non-mac openers: xdg-open/wslview can block until the browser
# exits, which looks like the script hung after the stack is up.
open_url() {
  if command -v open >/dev/null 2>&1 && [ "$OS" = "Darwin" ]; then open "$1"
  elif [ "$IS_WSL" = 1 ] && command -v wslview >/dev/null 2>&1; then wslview "$1" >/dev/null 2>&1 &
  elif [ "$IS_WSL" = 1 ] && command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Start-Process '$1'" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  else echo "    (could not open a browser -- open $1 yourself)"; fi
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
