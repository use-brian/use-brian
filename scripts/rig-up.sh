#!/usr/bin/env bash
#
# rig-up.sh — bring the local end-to-end rig up: Postgres 18 in Docker, the open
# stack on top of it, and an owner bearer token written to disk.
#
# Spec: docs/workflow/local-rig.md (platform tree). Teardown: scripts/rig-down.sh.
#
# Why this exists: booting the stack by hand is a five-step sequence with three
# silent failure modes (PG<18 rejects the baseline, MIGRATION_DIRS flips the
# migrator to `hosted` and skips the OSS tables, and an external DATABASE_URL
# means the launcher does NOT migrate). Each one produces a stack that starts
# cleanly and misbehaves later, so every session re-derived the sequence and paid
# for the same discoveries. This script is that sequence, once.
#
# It is idempotent: run it again and it reports the running rig instead of
# starting a second one. It never touches a non-loopback database, and it only
# ever manages the container it labelled itself.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$ROOT/.rig"
LOG="$STATE/stack.log"
MIGRATE_LOG="$STATE/migrate.log"
PIDFILE="$STATE/stack.pid"
SESSION_FILE="$STATE/session.json"

# The container is ours only if it carries this label — rig-down refuses to
# remove anything else, so a name collision can never eat someone's database.
RIG_LABEL="com.usebrian.rig=brain"
CONTAINER="${BRIAN_RIG_CONTAINER:-usebrian-brain}"
VOLUME="${BRIAN_RIG_VOLUME:-usebrian-brain-data}"
# PG18 is required (the baseline schema sets transaction_timeout, which PG<=17
# rejects) and pgvector must ship in the image (the baseline CREATE EXTENSIONs
# it). This is the same image the self-host recipe uses.
IMAGE="${BRIAN_RIG_IMAGE:-pgvector/pgvector:pg18}"

API_PORT_FILE="$STATE/api-port"
WEB_PORT=3003
DOC_SYNC_PORT=8080

READY_TIMEOUT="${BRIAN_RIG_TIMEOUT:-300}"
CORE_ONLY=1
FRESH=0
ADMIN_ONLY=0

say() { printf '[rig] %s\n' "$*"; }
warn() { printf '[rig] warning: %s\n' "$*" >&2; }
die() { printf '[rig] error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/rig-up.sh [options]

  --admin-only       isolated administrative fixture, no paid providers/workers
  --full             also start the channel connectors + browser relay
                     (default: core only — brain, api, doc-sync, app-web)
  --fresh            re-create the database from empty before booting
                     (drops the rig's container AND its data volume)
  --timeout <secs>   how long to wait for readiness (default 300)
  -h, --help         this help

Environment overrides: DATABASE_URL (else use-brian/.env, else the rig default),
BRIAN_RIG_CONTAINER, BRIAN_RIG_VOLUME, BRIAN_RIG_IMAGE, BRIAN_RIG_TIMEOUT,
USEBRIAN_API_PORT (default 4000, or the last recorded rig port).
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --admin-only) ADMIN_ONLY=1 ;;
    --full) CORE_ONLY=0 ;;
    --fresh) FRESH=1 ;;
    --timeout) shift; [ $# -gt 0 ] || die "--timeout needs a value"; READY_TIMEOUT="$1" ;;
    --timeout=*) READY_TIMEOUT="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
  shift
done

if [ "$ADMIN_ONLY" = 1 ]; then
  [ "$CORE_ONLY" = 1 ] && [ "$FRESH" = 0 ] || die "--admin-only cannot be combined with --full or --fresh"
  STATE="$ROOT/.rig/admin"
  LOG="$STATE/stack.log"
  MIGRATE_LOG="$STATE/migrate.log"
  PIDFILE="$STATE/stack.pid"
  SESSION_FILE="$STATE/session.json"
  API_PORT_FILE="$STATE/api-port"
  CONTAINER=usebrian-admin-test
  VOLUME=usebrian-admin-test-data
  RIG_LABEL="com.usebrian.rig=admin-test"
  IMAGE=pgvector/pgvector:pg18
  export USEBRIAN_ADMIN_ONLY=1
  export USEBRIAN_API_PORT="${USEBRIAN_API_PORT:-4100}"
fi
mkdir -p "$STATE"
if [ "$ADMIN_ONLY" = 1 ] && [ -f "$PIDFILE" ]; then
  previous_pid="$(cat "$PIDFILE")"
  if kill -0 "$previous_pid" 2>/dev/null; then
    previous_command="$(ps -p "$previous_pid" -o command= 2>/dev/null || true)"
    case "$previous_command" in
      *"$ROOT/scripts/launch.mjs --admin-only"*) ;;
      *) die "recorded pid is not this admin launcher; leaving it untouched" ;;
    esac
  fi
fi

# ── preflight ───────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker Desktop, Colima, or Podman."
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable. Start Docker Desktop (or \`colima start\`) and retry."
command -v pnpm >/dev/null 2>&1 || die "pnpm not found. Run \`corepack enable\`."
command -v node >/dev/null 2>&1 || die "node not found (this repo pins Node 22 via .nvmrc)."
[ -d "$ROOT/node_modules" ] || die "dependencies are not installed. Run \`pnpm install\` in $ROOT first."
API_PORT="$(node "$ROOT/scripts/launch-ports.mjs" "$API_PORT_FILE")" || die "invalid API port"

# The launcher PROMPTS on stdin when it has neither a model credential nor a
# persisted provider choice. Under nohup that prompt is an invisible hang, which
# is the single most expensive way this script could fail — so refuse up front,
# with the fix.
if [ "$ADMIN_ONLY" != 1 ] && ! node -e '
  const { existsSync, readFileSync } = require("node:fs")
  const { join } = require("node:path")
  const cfgPath = join(process.env.HOME, ".usebrian", "config.json")
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {}
  const dotenv = existsSync(process.argv[1]) ? readFileSync(process.argv[1], "utf8") : ""
  const inEnvFile = (k) => new RegExp(`^\\s*(export\\s+)?${k}\\s*=\\s*\\S`, "m").test(dotenv)
  const has = (k) => Boolean(process.env[k]?.trim()) || inEnvFile(k)
  const ok = cfg.preferredProvider || cfg.geminiApiKey
    || process.env.USEBRIAN_PREFERRED_PROVIDER
    || has("GEMINI_API_KEY") || has("VERTEX_PROJECT_ID") || has("DASHSCOPE_API_KEY")
  process.exit(ok ? 0 : 1)
' "$ROOT/.env"; then
  die "no model provider configured, and the launcher would block on an interactive prompt.
       Run \`pnpm start\` once in $ROOT to choose one (it persists to ~/.usebrian/config.json),
       or set GEMINI_API_KEY / VERTEX_PROJECT_ID / DASHSCOPE_API_KEY in $ROOT/.env."
fi

port_pids() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true; }
pid_command() { ps -p "$1" -o command= 2>/dev/null || echo '?'; }

rig_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

api_healthy() { curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$API_PORT/health" 2>/dev/null; }

# ── database coordinates (one source of truth: DATABASE_URL) ────────────────
eval "$(node "$ROOT/scripts/rig-env.mjs")" || die "could not resolve DATABASE_URL"
[ "$RIG_DB_LOOPBACK" = "1" ] || die "DATABASE_URL points at '$RIG_DB_HOST', which is not loopback.
       This script creates, stops and can delete that database — it refuses to aim at a
       remote or shared server. Point DATABASE_URL at 127.0.0.1 or unset it."

# ── already up? ─────────────────────────────────────────────────────────────
if pid="$(rig_pid)"; then
  recorded_api_port="$(node "$ROOT/scripts/launch-ports.mjs" "$API_PORT_FILE" --recorded)" || die "invalid recorded API port"
  [ "$API_PORT" = "$recorded_api_port" ] || die "rig is running on :$recorded_api_port; run scripts/rig-down.sh --keep-db before changing its API port"
fi
if [ "$FRESH" = "0" ] && pid="$(rig_pid)" && api_healthy; then
  say "rig is already up (launcher pid $pid) — refreshing the owner session only."
  mint_only=1
else
  mint_only=0
  if pid="$(rig_pid)"; then
    say "stopping the rig's previous stack (pid $pid) ..."
    down_args=(--keep-db)
    [ "$ADMIN_ONLY" = 1 ] && down_args+=(--admin-only)
    "$ROOT/scripts/rig-down.sh" "${down_args[@]}" >/dev/null
  fi
  for p in "$API_PORT" "$WEB_PORT" "$DOC_SYNC_PORT"; do
    pids="$(port_pids "$p")"
    if [ -n "$pids" ]; then
      for opid in $pids; do
        warn ":$p is held by pid $opid — $(pid_command "$opid")"
      done
      die "port :$p is already in use by something this rig did not start.
       Another stack (\`pnpm dev\`, \`turbo run dev\`) is probably running. Stop it first —
       this script will not adopt or kill a listener it does not own."
    fi
  done
fi

if [ "$mint_only" = "0" ]; then
  # An admin fixture may never adopt a normal or unlabelled database/volume.
  if [ "$ADMIN_ONLY" = 1 ]; then
    if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
      label="$(docker container inspect -f '{{index .Config.Labels "com.usebrian.rig"}}' "$CONTAINER")"
      [ "$label" = admin-test ] || die "admin fixture container has the wrong ownership label"
    fi
    if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
      label="$(docker volume inspect -f '{{index .Labels "com.usebrian.rig"}}' "$VOLUME")"
      [ "$label" = admin-test ] || die "admin fixture volume has the wrong ownership label"
    else
      docker volume create --label "$RIG_LABEL" "$VOLUME" >/dev/null
    fi
  fi
  # ── Postgres in Docker ────────────────────────────────────────────────────
  if [ "$FRESH" = "1" ]; then
    say "--fresh: removing the rig database ..."
    "$ROOT/scripts/rig-down.sh" --wipe >/dev/null
  fi

  # Probe existence by EXIT STATUS, not by the output: `docker inspect` writes an
  # empty line to stdout before failing on a missing object, so a
  # `$(... || echo missing)` idiom yields "\nmissing" and silently misses the
  # create branch (observed on Docker 29: the script tried to start a container
  # that did not exist). `container inspect` also avoids matching an image.
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    container_state="$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | tr -d '[:space:]')"
  else
    container_state='missing'
  fi
  case "$container_state" in
    running)
      say "database container '$CONTAINER' is already running."
      ;;
    missing)
      # The volume mounts at /var/lib/postgresql, NOT the /var/lib/postgresql/data
      # that every pre-18 recipe uses: the 18+ images store data in a
      # major-version subdirectory and abort at startup when they find a mount at
      # the old path ("there appears to be PostgreSQL data in ... (unused
      # mount/volume)"). The container then crash-loops with no obvious cause.
      say "creating database container '$CONTAINER' ($IMAGE) on :$RIG_DB_PORT ..."
      docker run -d \
        --name "$CONTAINER" \
        --label "$RIG_LABEL" \
        --restart unless-stopped \
        -e POSTGRES_USER="$RIG_DB_USER" \
        -e POSTGRES_PASSWORD="${RIG_DB_PASSWORD:-postgres}" \
        -e POSTGRES_DB="$RIG_DB_NAME" \
        -p "127.0.0.1:$RIG_DB_PORT:5432" \
        -v "$VOLUME:/var/lib/postgresql" \
        "$IMAGE" >/dev/null
      ;;
    *)
      say "starting stopped database container '$CONTAINER' ..."
      docker start "$CONTAINER" >/dev/null
      ;;
  esac

  # A pre-existing container published on a different host port would answer
  # nothing on the URL we are about to hand the stack. Say so rather than time out.
  published="$(docker container inspect -f '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostPort}} {{end}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
  case " $published " in
    *" $RIG_DB_PORT "*) ;;
    *) die "container '$CONTAINER' publishes port(s) [${published% }] but DATABASE_URL wants :$RIG_DB_PORT.
       Either point DATABASE_URL at the published port, or recreate the container:
       scripts/rig-down.sh --wipe   (deletes its data)" ;;
  esac

  say "waiting for Postgres ..."
  deadline=$(( $(date +%s) + 90 ))
  until docker exec "$CONTAINER" pg_isready -U "$RIG_DB_USER" -d "$RIG_DB_NAME" -q 2>/dev/null; do
    [ "$(date +%s)" -lt "$deadline" ] || {
      docker logs --tail 30 "$CONTAINER" >&2 || true
      die "Postgres did not become ready within 90s (logs above)."
    }
    sleep 1
  done

  pg_major="$(docker exec "$CONTAINER" psql -U "$RIG_DB_USER" -d "$RIG_DB_NAME" -tAc \
    "select current_setting('server_version_num')::int / 10000" 2>/dev/null | tr -dc '0-9' || echo '')"
  if [ -n "$pg_major" ] && [ "$pg_major" -lt 18 ]; then
    die "container '$CONTAINER' runs PostgreSQL $pg_major. The baseline schema sets
       transaction_timeout, which PG<=17 rejects on the first migration.
       Recreate it on PG18: scripts/rig-down.sh --wipe   (deletes its data)"
  fi

  # The baseline creates both extensions itself, but it does so as whatever role
  # is migrating; creating them here first fails loudly and early if the image
  # has no pgvector, instead of 4000 lines into the baseline.
  docker exec -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" \
    psql -U "$RIG_DB_USER" -d "$RIG_DB_NAME" -v ON_ERROR_STOP=1 -q \
    -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;' \
    || die "could not create the vector/pg_trgm extensions. Is '$IMAGE' a pgvector image?"

  # ── migrate (the launcher will NOT, with an external DATABASE_URL) ────────
  # MIGRATION_DIRS must be EMPTY here: a non-empty value flips the migrator's
  # app.migration_edition to 'hosted', and the OSS-only migrations (e.g.
  # 280_oss_connectors.sql) then no-op — the stack boots and the connector
  # tables are simply absent. The platform `.env` sets it for the hosted tree,
  # so clearing it is not optional.
  say "applying open migrations ..."
  if ! ( cd "$ROOT" && env DATABASE_URL="$RIG_DB_URL" MIGRATION_DIRS= \
           pnpm --filter @use-brian/api migrate ) >"$MIGRATE_LOG" 2>&1; then
    tail -n 25 "$MIGRATE_LOG" >&2
    die "migrations failed (full log: $MIGRATE_LOG)"
  fi
  applied="$(grep -c '^  apply: ' "$MIGRATE_LOG" || true)"
  say "migrations ok (${applied:-0} newly applied; log: ${MIGRATE_LOG#"$ROOT/"})"

  if [ "$ADMIN_ONLY" = 1 ]; then
    docker exec -i "$CONTAINER" psql -U "$RIG_DB_USER" -d "$RIG_DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_fixture_app') THEN
    CREATE ROLE admin_fixture_app LOGIN PASSWORD 'fixture-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_fixture_app' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Administrative fixture app role has unsafe privileges';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO admin_fixture_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO admin_fixture_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO admin_fixture_app;
ALTER ROLE admin_fixture_app SET app.current_user_id = '00000000-0000-0000-0000-000000000000';
SQL
  fi

  # ── the stack (the maintained launcher, headless) ─────────────────────────
  say "starting the stack ($([ "$CORE_ONLY" = 1 ] && echo 'core only' || echo 'full')) ..."
  : >"$LOG"
  launch_env=(
    DATABASE_URL="$RIG_DB_URL"
    MIGRATION_DIRS=
    USEBRIAN_NO_BROWSER=1
    USEBRIAN_API_PORT="$API_PORT"
  )
  [ "$CORE_ONLY" = 1 ] && launch_env+=(USEBRIAN_CORE_ONLY=1)
  printf '%s\n' "$API_PORT" >"$API_PORT_FILE"
  launch_args=()
  [ "$ADMIN_ONLY" = 1 ] && launch_args+=(--admin-only)
  nohup env "${launch_env[@]}" \
    node "$ROOT/scripts/launch.mjs" "${launch_args[@]}" >>"$LOG" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  launcher_pid="$(cat "$PIDFILE")"
  say "launcher pid $launcher_pid (log: ${LOG#"$ROOT/"})"
fi

# ── readiness: the port, then a real database round-trip ────────────────────
# "Up is not alive": /health is registered before the pool is used and answers
# with Postgres down. The owner-session mint is the cheapest call that proves
# the whole path — it inserts the owner user and provisions a workspace — so it
# doubles as the readiness gate and as the token an e2e run needs.
deadline=$(( $(date +%s) + READY_TIMEOUT ))
launcher_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
stage='api'
while :; do
  if [ -n "$launcher_pid" ] && ! kill -0 "$launcher_pid" 2>/dev/null; then
    tail -n 30 "$LOG" >&2
    rm -f "$PIDFILE"
    die "the stack exited during boot (log tail above; full log: $LOG)"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    tail -n 30 "$LOG" >&2
    die "not ready within ${READY_TIMEOUT}s, waiting on: $stage (full log: $LOG).
       A cold first boot compiles the workspace — retry with --timeout 600."
  fi
  if ! api_healthy; then stage="api :$API_PORT"; sleep 2; continue; fi
  code="$(curl -sS --max-time 20 -o "$SESSION_FILE.tmp" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$API_PORT/auth/local-session" 2>/dev/null || echo 000)"
  case "$code" in
    200)
      if grep -q '"accessToken"' "$SESSION_FILE.tmp" 2>/dev/null; then break; fi
      stage='owner session (200 without a token)'
      ;;
    403)
      # The route is gated on an OSS, non-Cloud-Run process. The launcher sets
      # USEBRIAN_EDITION=oss itself, so a 403 means something in the environment
      # overrode it — never something waiting will fix.
      die "the api refused to mint an owner session (403 local_session_disabled).
       Something is overriding USEBRIAN_EDITION=oss (or K_SERVICE is set) in this
       environment. Response: $(head -c 200 "$SESSION_FILE.tmp" 2>/dev/null)"
      ;;
    503)
      die "the api has no JWT_SECRET (503 jwt_secret_unset). Delete the stale value from
       $ROOT/.env or ~/.usebrian/config.json and retry."
      ;;
    *)
      stage="owner session (api up, http $code — database not answering yet)"
      ;;
  esac
  sleep 2
done
mv "$SESSION_FILE.tmp" "$SESSION_FILE"
chmod 600 "$SESSION_FILE"

# app-web binds its port early and compiles the first route on demand; the port
# is the honest gate, so note the compile rather than waiting it out.
web_ready=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -n "$(port_pids "$WEB_PORT")" ]; then web_ready=1; break; fi
  sleep 2
done

# ── summary ─────────────────────────────────────────────────────────────────
token="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).accessToken)' "$SESSION_FILE")"
store_status='off'
grep -q 'chat message store (' "$LOG" 2>/dev/null && store_status='on (:8092)'

cat <<SUMMARY

[rig] ready.
  app        http://localhost:$WEB_PORT$([ "$web_ready" = 1 ] || echo '   (not listening yet — see the log)')
             sign-in is automatic: http://localhost:$WEB_PORT/api/auth/local-session
  api        http://127.0.0.1:$API_PORT      (health: /health)
  doc-sync   ws://127.0.0.1:$DOC_SYNC_PORT
  database   $RIG_DB_DISPLAY  (container '$CONTAINER', from $RIG_DB_SOURCE)
  chat-archive $store_status
  session    ${SESSION_FILE#"$ROOT/"}   (owner bearer token, mode 600, re-minted each rig-up)
  logs       ${LOG#"$ROOT/"}

  authenticated call:
    TOKEN=\$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("${SESSION_FILE#"$ROOT/"}","utf8")).accessToken)')
    curl -s -H "Authorization: Bearer \$TOKEN" http://127.0.0.1:$API_PORT/api/assistants | head -c 400

  psql:      docker exec -it $CONTAINER psql -U $RIG_DB_USER -d $RIG_DB_NAME
  follow:    tail -f ${LOG#"$ROOT/"}
  teardown:  scripts/rig-down.sh$([ "$ADMIN_ONLY" = 1 ] && echo " --admin-only" || echo " (add --wipe to delete the database)")

SUMMARY

[ -n "$token" ] || warn "the session file has no accessToken — authenticated calls will fail."
exit 0
