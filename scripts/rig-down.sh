#!/usr/bin/env bash
#
# rig-down.sh — tear the local end-to-end rig down.
#
# Spec: docs/workflow/local-rig.md (platform tree). Boot: scripts/rig-up.sh.
#
# Default: stop the stack, stop the database container, KEEP the data (so the
# next rig-up is seconds, not a full migration). `--wipe` deletes the database.
#
# Two safety rules, because this script deletes things:
#   - it only ever touches a container carrying the rig's own label, so a name
#     collision with someone's real database cannot be removed by accident; and
#   - it only kills a listener on a rig port whose command looks like part of
#     this stack, and it names every pid it signals.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.rig"
PIDFILE="$STATE/stack.pid"
SESSION_FILE="$STATE/session.json"

RIG_LABEL_KEY='com.usebrian.rig'
CONTAINER="${BRIAN_RIG_CONTAINER:-usebrian-brain}"
VOLUME="${BRIAN_RIG_VOLUME:-usebrian-brain-data}"

# Every port the launcher can bind: api, app-web, doc-sync, the four channel
# connectors, the chat archive, and the browser relay's search range.

WIPE=0
KEEP_DB=0
ADMIN_ONLY=0

say() { printf '[rig] %s\n' "$*"; }
warn() { printf '[rig] warning: %s\n' "$*" >&2; }

usage() {
  cat <<'USAGE'
Usage: scripts/rig-down.sh [options]

  (default)     stop the stack + stop the database container, keeping its data
  --admin-only  stop only the isolated administrative fixture
  --wipe        also DELETE the database (removes the rig container + volume)
  --keep-db     stop the stack only; leave the database container running
  -h, --help    this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-only) ADMIN_ONLY=1 ;;
    --wipe) WIPE=1 ;;
    --keep-db) KEEP_DB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf '[rig] error: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done

if [ "$WIPE" = 1 ] && [ "$KEEP_DB" = 1 ]; then
  printf '[rig] error: --wipe and --keep-db contradict each other.\n' >&2
  exit 1
fi

if [ "$ADMIN_ONLY" = 1 ]; then
  [ "$WIPE" = 0 ] || { printf '[rig] error: --admin-only does not support --wipe\n' >&2; exit 1; }
  STATE="$ROOT/.rig/admin"
  PIDFILE="$STATE/stack.pid"
  SESSION_FILE="$STATE/session.json"
  CONTAINER=usebrian-admin-test
  VOLUME=usebrian-admin-test-data
fi

# ── the stack ───────────────────────────────────────────────────────────────
API_PORT="$(node "$ROOT/scripts/launch-ports.mjs" "$STATE/api-port" --recorded)" || exit 1
RIG_PORTS=("$API_PORT" 3003 8080 8090 8091 8092 8093 8094 8095 8096)
stop_pid() {
  local pid="$1" label="$2"
  kill -0 "$pid" 2>/dev/null || return 0
  say "stopping $label (pid $pid) ..."
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  warn "pid $pid ignored SIGTERM after 15s — sending SIGKILL."
  kill -KILL "$pid" 2>/dev/null || true
}

if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    if [ "$ADMIN_ONLY" = 1 ]; then
      command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
      if kill -0 "$pid" 2>/dev/null; then
        case "$command" in
          *"$ROOT/scripts/launch.mjs --admin-only"*) ;;
          *) warn "recorded pid is not this admin launcher; leaving it untouched"; exit 1 ;;
        esac
      fi
    fi
    stop_pid "$pid" 'the launcher'
  fi
  rm -f "$PIDFILE"
else
  if [ "$ADMIN_ONLY" = 1 ]; then
    say "no launcher pid recorded; checking persisted administrative runtime ownership."
  else
    say "no launcher pid recorded — sweeping the rig ports anyway."
  fi
fi

if [ "$ADMIN_ONLY" = 1 ]; then
  node "$ROOT/scripts/rig-admin.mjs" --stop-owned "$ROOT"
  sleep 1
fi

# The launcher SIGTERMs its own children, but it spawns them through pnpm, which
# does not always forward the signal. Sweep what is left holding a rig port.
#
# Ownership is proved by the process's working directory, not by its command
# line: `node`, `tsx` and `next` are what half the machine's dev servers look
# like, and :8080 in particular is a port other projects use. Every child the
# launcher starts runs inside this checkout, so a listener whose cwd is not under
# it is somebody else's and is reported rather than killed.
pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk '/^n/ { print substr($0, 2); exit }'
}

swept=0
if [ "$ADMIN_ONLY" = 0 ]; then
for port in "${RIG_PORTS[@]}"; do
  for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true); do
    cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    [ -n "$cmd" ] || continue
    cwd="$(pid_cwd "$pid")"
    case "$cwd" in
      "$ROOT"|"$ROOT"/*)
        say "sweeping :$port (pid $pid) — $(printf '%.80s' "$cmd")"
        kill -TERM "$pid" 2>/dev/null || true
        swept=$((swept + 1))
        ;;
      *)
        warn ":$port is held by pid $pid, working directory '${cwd:-unknown}' — outside this
         checkout, so it is not part of the rig. Leaving it alone: $(printf '%.60s' "$cmd")"
        ;;
    esac
  done
done
fi
[ "$swept" = 0 ] || sleep 2

rm -f "$SESSION_FILE"

# ── the database ────────────────────────────────────────────────────────────
# Existence by exit status; `docker inspect` prints an empty line to stdout
# before failing on a missing object, so output-based probes misread it.
container_label=''
container_present=0
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  container_present=1
  container_label="$(docker container inspect -f "{{index .Config.Labels \"$RIG_LABEL_KEY\"}}" "$CONTAINER" 2>/dev/null | tr -d '[:space:]')"
fi
if [ "$ADMIN_ONLY" = 1 ] && [ "$container_present" = 1 ] && [ "$container_label" != admin-test ]; then
  warn "admin fixture container has the wrong label; leaving it untouched"
  exit 1
fi
container_exists=0
[ -n "$container_label" ] && container_exists=1
if [ "$container_exists" = 0 ] && [ "$container_present" = 1 ]; then
  warn "a container named '$CONTAINER' exists but carries no $RIG_LABEL_KEY label — this rig did not
         create it, so it is left untouched. Remove it yourself if that is what you want."
elif [ "$container_exists" = 1 ]; then
  if [ "$WIPE" = 1 ]; then
    say "removing database container '$CONTAINER' and volume '$VOLUME' (all local brain data) ..."
    docker rm -f "$CONTAINER" >/dev/null
    docker volume rm "$VOLUME" >/dev/null 2>&1 || warn "volume '$VOLUME' was already gone."
  elif [ "$KEEP_DB" = 1 ]; then
    say "leaving database container '$CONTAINER' running."
  else
    say "stopping database container '$CONTAINER' (data kept in volume '$VOLUME') ..."
    docker stop "$CONTAINER" >/dev/null
  fi
else
  say "no rig database container to stop."
fi

if [ "$WIPE" = 1 ]; then
  say "down. The next rig-up re-creates the database and re-applies every migration."
else
  say "down. The next rig-up reuses the existing database."
fi
