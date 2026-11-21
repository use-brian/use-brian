# M6 qualification harness

Runs the M6 whole-system qualification matrix by invoking the existing
harnesses and repository gates, one step at a time, and tabulates the results
against the section 7 budgets and the latest receipts. Plan (matrix, metric
definitions, pass/fail rules): brian-platform
`docs/plans/oss-chat-m6-qualification-plan.md`. Receipt:
`docs/plans/evidence/oss-chat-replacement/canonical-publication/m6-harness.md`.

Nothing here measures anything itself. A step without its environment is
recorded as `skipped` with the reason; a harness that exits 0 without writing
its output is `error`, not a pass.

```sh
export PATH=<Node >= 22.15 and pnpm 10 first>:$PATH
node scripts/testing/m6/run-matrix.mjs --list
node scripts/testing/m6/run-matrix.mjs --profile dry-run --plumbing --scenarios empty-private/legacy \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin --out /abs/m6-dry
node scripts/testing/m6/run-matrix.mjs --steps fixed20-oss-counts,fixed20-oss-lookup --cold --plumbing \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin --out /abs/m6-a7a8   # rows A1, A7 and A8 only
node scripts/testing/m6/collect.mjs --run /abs/m6-dry          # writes results.md and results.json
node scripts/testing/m6/collect.mjs --verify-baseline          # every transcribed baseline quote is still in its receipt
node scripts/testing/m6/run-matrix.mjs --profile full --out /abs/m6-run   # the M6 run, once M1 to M5 close
```

## Files

| File | Purpose |
|---|---|
| `run-matrix.mjs` | Orchestrator. Probes the environment, then runs each selected step: disposable PostgreSQL 18 fixture where needed, the harness command, a log, and `steps/<id>.json` with status, reason, exit code, duration, command (environment variable names only), fixture identity and output paths. Writes `run.json` with the probes and the source identity (HEAD, `git diff HEAD` digest, untracked digest) at start and end. Options: `--profile dry-run\|full\|<group>`, `--steps a,b`, `--scenarios`, `--warm-samples`, `--cold` (adds `fixed20-oss-cold`), `--cold-samples N` (restarts per scenario, default 3), `--pg-bin`, `--plumbing`, `--allow-destructive`, `--timeout-scale`. |
| `collect.mjs` | Reads a run directory, `baseline.json` and the machine receipts it cites, and writes one table (Markdown and JSON) with before / baseline / after / budget / verdict per result line, plus the qualification verdict and its reasons. |
| `matrix.mjs` | Single registry of rows, metrics and budgets used by both scripts. |
| `baseline.json` | Before (2026-11-16 one-turn baseline) and baseline figures transcribed from the receipts, each with a verbatim `quote` that `--verify-baseline` checks. |

Source identities hash untracked file contents and link targets, including
same-size edits whose timestamps were preserved. Qualification requires explicit
clean start/end identities for both repositories, matching HEAD and digests,
proven unchanged state and results for every matrix row. An immutable disposable
copy of a dirty checkout preserves evidence but does not satisfy the clean-source
gate.

The admission measurement now records received SSE text frames beside the real
per-frame delivery admission callbacks and asserts exactly one admission at each
text dispatch. Protected non-text events retain separate attribution. The
transfer measurement now enables the existing turn SQL ledger and exports its
foreground, transaction/control, failed and overflow counters. Its pinned managed
runtime does not ship `pg_stat_statements`; transferred nested work remains
explicitly unmeasured. Historical receipts lacking these fields are unmeasured.

`chat-import-receipt.mjs` performs the local-owner sign-in, real ordinary HTTP
chat and durable reopened history check. Its activation probes remain pending,
so the complete-runtime receipt cannot pass yet.

`fixed20-scaling` measures A9's six independent axes on serial database clones
of one newly migrated owned template. Set `BRIAN_CHAT_COST_MESSAGES` to 10, 100
or 1,000 and `BRIAN_CHAT_COST_DEPENDENCIES` to 1, 10 or 100 on the underlying
test to select one fixture. Every dependency comes from a distinct private
transcript created and captured through canonical ports. Retained rows use the
canonical batch publisher and are reopened before measurement. Seeding time is
reported separately. No numeric scaling ceiling is invented; the complete
physical-accounting limitation stays visible beside the curve.

`run-runtime-acceptance.mjs` creates an owned PostgreSQL fixture, provisions a
fictional user and native device with the canonical stores, and signs a real
JWT used by the unchanged API middleware. It checks exact received output,
reopened durable history, anonymous rejection and a different fixture identity's
denial, with matching source/build hashes before and after. The isolated
`K_SERVICE` marker suppresses local-owner shortcuts and the personal
subscription runtime. `--workers --idle` records ten seconds of SQL and sampled
lock waits after `/health` and before the ordinary turn. The harness then
checks Office export, CRM contact, campaign draft, file ingest, and injected
mailbox archive search through the running API.

`--hosted` selects the built platform API and applies the platform migration
directory alongside the open migrations. `--hosted --local-storage` selects
the supported local-development file store for a deterministic fixture. This
mode leaves `K_SERVICE` unset and uses the loopback Gemini protocol fixture.

```sh
node scripts/testing/m6/run-runtime-acceptance.mjs --oss-root /abs/frozen/use-brian \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin --out /abs/runtime.json
# Only with explicit paid-provider authorization and the shared campaign cap:
node scripts/testing/m6/run-runtime-acceptance.mjs --live --phase m6 \
  --ledger /private/tmp/oss-chat-m6-m7-provider-spend.json \
  --credentials-file /abs/configured/.env --oss-root /abs/frozen/use-brian \
  --pg-bin /opt/homebrew/opt/postgresql@18/bin --out /abs/live.json
```

The live transport parses only the configured DashScope key from the named
credential file; it does not load its database settings. It reserves each
chargeable attempt atomically against US$25 total and US$10/15 phase caps,
including API retries and background classifiers. It uses the published
International Qwen 3.5 Flash rates, forces a single text completion, disables
thinking/search/tools and requests at most 1,024 tokens. Reservations still
cover the documented full model input, visible output and thinking ceilings.
Actual provider token usage settles the conservative list-price estimate;
unknown outcomes retain the whole reservation. The shared ledger stores no
prompt, output, access token or provider key. Invoice totals are not claimed.

Run directory layout: `run.json`, `steps/<id>.json`, `raw/<id>/` (harness
outputs, vitest JSON), `logs/<id>.log`, then `results.md` and `results.json`
from the collector.

## Steps, environment and duration

Durations: "dry run" figures were measured by the plumbing dry run on
2026-11-17 (loaded development machine, other agents running); the rest are
estimates from the cited receipts. Every database step adds one fixture
provisioning (fresh 759-file migration chain).

| Step | Rows | Environment it needs | Duration |
|---|---|---|---|
| `fixed20-oss-counts` | A1, C2 | PostgreSQL 18 with pgvector, pg_trgm and the `pg_stat_statements` library; built `packages/core/dist` and `packages/agent-runtime/dist` | dry run: see the receipt (one scenario); about 10 s per further scenario |
| `fixed20-hosted-counts` | A2 | as above plus the platform root (`packages/api-platform/migrations`) | as above |
| `fixed20-oss-warm` | A3 | as `fixed20-oss-counts` | 15 to 30 min (186 turns) |
| `fixed20-oss-frag-20`, `-200`, `-2000` | A4 | as `fixed20-oss-counts` | 3 to 8 min each |
| `fixed20-oss-stale-room` | A5 | as `fixed20-oss-counts` | 3 to 5 min |
| `fixed20-oss-cold` | A7 | as `fixed20-oss-counts`; the fixture's owned `restart()` | plumbing run: 252 s plus provisioning for 18 restarts (about 14 s per restart and vitest process) |
| `fixed20-oss-lookup` | A8 | as `fixed20-oss-counts` | 10 to 20 min: the warm samples of each scenario (`--warm-samples`, default 31), since A8 carries the per-scenario p50 latency budget (2026-11-17); the one-sample plumbing run took 24 s plus provisioning |
| `admission` | B1 | PostgreSQL 18 | dry run: see the receipt (9 requests) |
| `doc-thread-32` | A11 | PostgreSQL 18 | 10 to 60 min (32 dock turns on one Page; cost grows with the thread until M7) |
| `context-aware-chat`, `context-aware-chat-hosted` | A12, A13 | PostgreSQL 18, built core and agent-runtime packages. The hosted-schema step also requires the platform root. | 3 to 6 min per schema, including fixture provisioning |
| `model-calls` | C1 | PostgreSQL 18 | 3 to 6 min (13 turns) |
| `import-graph-chat` | D1 | none | dry run: seconds |
| `import-graph-m4` | D2 | platform root (hosted entry) | dry run: seconds |
| `codemod-verify` | D6 | none | dry run: about 6 s |
| `runtime-trace-oss` | D3, D5 | PostgreSQL 18; built `apps/api/dist/index.js` (`pnpm --filter @use-brian/api-open build`; staleness is not checked, rebuild first); Node >= 22.15 | dry run: see the receipt |
| `runtime-trace-oss-workers` | D4 | as above | 2 to 4 min |
| `browser-<journey>-<390\|1440>` (24 steps) | E1 to E18 | `M5_CHROME` (Chrome for Testing), `PLAYWRIGHT_MODULE` or a resolvable `playwright-core` (not a repository dependency), a running local stack with the scripted provider (`M5_API`, `M5_APP`), `M5_WORK_DIR/fixtures.json` from `m5-qualification-fixtures.mjs` | 1 to 5 min each; dock journeys last on a fresh cluster (M5Q-10) |
| `browser-restart-1440`, `browser-restart2-1440` | E19 | as above plus `--allow-destructive` (kills the shared API) | 5 to 20 min each |
| `desktop-package` | F0 | full Xcode selected (`xcodebuild -version` succeeds) | 10 to 25 min |
| `desktop-journey-a` to `-e`, `-companion` | F1 to F6 | a packaged-UI journey driver, which does not exist; always skipped with that reason | not runnable |
| `desktop-unit` | F7 | pnpm | 1 to 3 min |
| `transfer` | A6, G1 | `USEBRIAN_MANAGED_POSTGRES_TEST_ARTIFACT` (installed managed PostgreSQL artifact matching the release pin); optional `USEBRIAN_TRANSFER_TEST_PGLITE_TEMPLATE` | about 10 min with a pristine 8273 template, about 40 min without |
| `launcher-receiving` | G2 | as `transfer` | 3 to 8 min |
| `gate-test` | H1 | platform root | 16 to 40 min |
| `gate-smoke` | H2 | platform root | dry run: seconds |
| `gate-check` | H3 | platform root | 2 to 5 min |
| `gate-check-subset` | none (dry run only) | platform root | dry run: seconds |
| `gate-verify-api-deploy` | H4 | platform root | 4 to 10 min |
| `gate-api-open` | H5 | platform root | 3 to 8 min |
| `gate-department-isolation` | H6 | PostgreSQL 18 | 60 to 120 min serial (full profile, 11 shards) |

The full profile is roughly 4 to 7 hours serial, dominated by the department
isolation matrix, `pnpm test`, the warm fixed-20 run and the browser journeys.

## Budgets decided 2026-11-17

Fused admission is the production admission owner (migration 8289) and the 999
nested-statement ceiling is retired. `SCENARIO_BUDGETS` in `matrix.mjs` holds the
per-scenario budgets for the no-tool (A1, A3) and one-lookup (A8) workloads:
permission work is the measured fused-admission median nested statements plus 20%,
and the M6 latency metric is the warm wall-time p50, budgeted at the measured
fused-admission p50 (at least 20 warm samples). A permission-work pass stays
provisional while nested statements are not complete physical accounting. Receipt: brian-platform
`docs/plans/evidence/oss-chat-replacement/canonical-publication/m1-fused-admission-adoption.md`.

## Fixed-20 foreground SQL targets

The 2026-11-19 decision makes 50 no-tool and 100 one-lookup foreground SQL
round trips indicative targets across M1–M7. The collector marks measured
comparisons `recorded`, reports the actual count and target, and shows each
overrun in Markdown and the JSON `overTargetBy` field. Its CLI summary counts
the over-target results. A count above its target alone does not fail
qualification. Required counts, sample coverage, latency, permission work,
behavior, source identity and accounting checks still apply. Raw historical
receipts are retained.

## Cold and one-lookup modes

**Cold (A7).** The step provisions one fixture, then for every scenario and
every cold sample restarts the owned cluster (`restart()` in
`scripts/crm/local-fixture.mjs`: fast shutdown, new postmaster on the same data
directory, port and settings) and runs a new vitest process with two samples of
that scenario. Sample 0 is the cold column: empty shared buffers, new backends
with empty catalog, relation and plan caches, a fresh API connection pool and a
first request in a fresh Node process. Sample 1 in the same process is the
paired warm column. The OS page cache is not flushed (that needs elevated
privileges), and each sample's own fixture setup (users, workspace, session
rows) runs on the restarted cluster before the measured request, so "cold"
means a restarted PostgreSQL, not cold storage. The collector reports shared
block reads (`pg_stat_statements` `shared_blks_read`) per column as evidence
that the restart emptied the buffers. Cold and paired warm foreground maxima
are compared separately with the indicative target of 50.

**One lookup (A8).** `BRIAN_CHAT_COST_TOOL=lookup` on the fixed-20 harness
wires the capability catalog (connector and MCP settings stores, the
introspection lane restricted to `listPendingApprovals`). The scripted provider's
first round makes one call, `mcp_call` with `server: introspection`,
`tool: listPendingApprovals`, `args: {}`, which runs one RLS-gated read of the
fixture database through the real pending-approvals store; its fixed result
("No approvals are pending in this workspace.") must reach the second round,
which streams the same 20 frames. Statements and nested statements are counted
exactly as in the no-tool turn; the harness also records the statements issued
while the lookup port ran. It has no connector network and starts no deferred
jobs. `BRIAN_CHAT_COST_TOOL=catalog` wires the same catalog without a call, to
separate catalog preparation from the call (diagnostic only; no matrix step).
The no-tool scenarios are unchanged when the variable is unset.

### Concurrent context-aware Chat (A14 and A15)

The `concurrent-context-chat` and `concurrent-context-chat-hosted` steps start the
open API composition with its normal background workers and a deterministic,
in-process model provider. The latter step also applies the hosted schema
overlay. The results cover database and API work on local loopback. Hosted
ingress, live model calls and the separate hosted worker service need their own
measurement.

The default diagnostic compares one, two, and four simultaneous requests on a
four-connection application pool. Each width uses two waves in the same dense
workspace, with distinct users, devices and personal sessions. Each user has
private Memory, a real session attachment and a shared indexed File to look up.
The full fixture has 232 Memory rows, including eight live rows per user,
65,925 derivation edges and 24 indexed Files. The second wave uses each user's
durable conversation from the first. Every turn
checks the exact Memory, File index, attachment tool result, SSE reply and reopened
transcript. The fixture also checks each user's receipt for accidental inclusion
of the other users' private inputs. Readback is outside the wave's timing window.

The dense Memory seed suspends named derivation triggers only while inserting
the unrelated synthetic graph. After restoring the triggers, the ordinary
owner refreshes the native catalog witness in the same transaction. This keeps
the guard on its normal fast path and lets the portable-restore check
authenticate the same database with the installed trigger contract intact.

The receipt records each turn's first text, terminal event, HTTP completion, and
the route's query, checkout and publication timing fields when available. A
fixture-only PostgreSQL observer samples heavyweight locks against active request
backends. Rows show fixed operation names, the blocking request slot or pool role,
and whether the blocker was active or idle in a transaction. These samples can
miss short waits and show the top-level operation rather than its nested statement.
The receipt also counts observed conversation-conversion worker calls during
each wave. SQL and checkout time are sums that can include overlapping work.
The matrix marks each width and phase against the five-second target for every
turn to reach its verified terminal SSE `done` event. First text, HTTP response
close and the count of turns over target appear alongside that verdict. Compare
matching source identities, pool sizes, widths and worker settings, and inspect
per-turn attribution before assigning a slow wave to lock contention.

For a shorter direct run use the marker-verified local fixture command below.
`BRIAN_CONTEXT_CHAT_LOAD_WIDTHS=2` selects a two-user wave and its follow-up.

```sh
BRIAN_CONTEXT_CHAT_LOAD=1 BRIAN_CONTEXT_CHAT_LOAD_WIDTHS=2 \
BRIAN_CONTEXT_CHAT_LOAD_OUTPUT=/abs/concurrent-context-chat.json \
node scripts/crm/local-fixture.mjs --pg-bin /path/to/postgresql-18/bin -- \
env PG_POOL_MAX=4 PG_STATEMENT_TIMEOUT_MS=15000 \
pnpm --filter @use-brian/api exec vitest run --config vitest.integration.config.ts \
src/application-platform/__tests__/concurrent-context-chat.integration.test.ts
```

## Prerequisites outside the repository

- PostgreSQL 18 with pgvector, pg_trgm and `pg_stat_statements` (Homebrew
  `postgresql@18` here).
- Chrome for Testing and `playwright-core` for the browser journeys (the M5 pass
  installed `playwright-core` in a session scratch directory).
- The managed PostgreSQL artifact for G1/G2 (the M1 receipts used a relocated
  bundle under `/private/tmp`).
- A running local stack for E rows: the maintained container rig refuses
  migration 8274 (superuser migrator), so use `scripts/launch.mjs` with
  `USEBRIAN_LOCAL_DATABASE=managed-postgres` and a disposable `HOME`, as the M5
  receipt did.

## Safety

Timed warm, one-lookup and context-aware Chat steps, including the concurrent waves, require a task-owned quiescence handshake. Use a
fresh freeze ID for each coordinated measurement window. Each active owner wraps
their final build/test/browser/fixture command with `quiescence.mjs run --dir
/abs/quiet --freeze-id final-1 --owner backend [--fixture /owned/fixture/path]
-- command args`. The wrapper records machine spawn/exit times, observed
descendant PIDs and launch identities, and fixture disposal; it records executable
paths without command arguments or credentials. Owners then run `quiescence.mjs
ack --dir /abs/quiet --freeze-id final-1 --owner backend`. A code-only owner with
no task workloads for this freeze must explicitly pass `--no-workloads`. An ack
is also the owner's hold on new builds, typechecks, tests, browser and fixtures
until the measurement owner releases the window. Do not wrap the measurement
runner itself as an outstanding workload in this hold.

Supply `--quiescence-dir /abs/quiet --freeze-id final-1
--quiescence-owners root,m6,frontend,backend` to `run-matrix.mjs`. Missing, stale,
changed or active owner receipts prevent the timed step from starting. The runner
records read-only process inventories and receipt hashes before and after the
window. New wrapped work or changed acknowledgements invalidate controlled-load
qualification while retaining numeric outcomes. Process identity includes launch
time and executable, so a reused PID does not stand for the prior process.
This proves only declared task-owned workload quiet; machine background work is
recorded and remains a measurement limitation. Inventory failure stops the gate.


The orchestrator never connects to an ambient, rig or personal database:
`local-fixture.mjs` refuses non-loopback URLs and creates a new cluster on a
random port, and `chat-import-receipt.mjs` refuses port 5432. It never kills
processes it did not start (child process groups only). It writes only inside
the run directory, except gate commands, which write their usual build outputs.
