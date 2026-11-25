#!/usr/bin/env bash
# Usage: smoke-linked-task.sh /path/to/pg18/bin [/path/to/sidanCode]
# Requires installed/built Use Brian workspace dependencies and pgvector/pg_trgm.
set -euo pipefail
pg_bin=$(cd "${1:?provide a PostgreSQL 18 bin directory}" && pwd)
sidan=$(cd "${2:-$(dirname "$0")/../../../sidanCode}" && pwd)
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
(cd "$sidan" && go build -o "$work/sidanCode" .)
node scripts/crm/local-fixture.mjs --pg-bin "$pg_bin" -- node --import tsx \
  packages/api/scripts/smoke-linked-task.ts "$work"
