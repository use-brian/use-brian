/**
 * M6 qualification matrix: the single registry of matrix rows, metrics and
 * budgets shared by `run-matrix.mjs` (what to run) and `collect.mjs` (how to
 * tabulate). Plan: brian-platform docs/plans/oss-chat-m6-qualification-plan.md.
 *
 * Nothing here measures anything. Every number comes from an existing harness
 * (see `HARNESSES`); a row without a harness is listed with `unmeasured` so the
 * report can never present it as passing.
 */

/** Existing harnesses, by invocation only. Paths are OSS-relative unless `plat:`. */
export const HARNESSES = {
  contextAwareChat: 'packages/api/src/application-platform/__tests__/context-aware-chat-latency.integration.test.ts',
  fixed20: 'packages/api/src/application-platform/__tests__/chat-architecture-cost.integration.test.ts',
  admission: 'packages/api/src/turn/__tests__/turn-admission-measurement.integration.test.ts',
  routing: 'packages/api/src/turn/__tests__/turn-routing-route.integration.test.ts',
  importGraph: 'scripts/testing/import-graph.mjs',
  moduleTrace: 'scripts/testing/chat-import-receipt.mjs (with scripts/testing/module-trace-hook.mjs)',
  codemod: 'scripts/testing/runtime-importer-codemod.mjs',
  browser: 'apps/app-web/scripts/m5-controller-qualification-browser.mjs (with m5-qualification-harness.mjs, m5-qualification-fixtures.mjs, m5-scripted-provider.mjs)',
  transfer: 'packages/api/src/db/managed-postgres/__tests__/transfer.native.test.ts',
  launcher: 'packages/api/src/db/managed-postgres/__tests__/launcher-receiving.native.test.ts',
  desktopUnit: 'apps/app-desktop (pnpm --filter @use-brian/app-desktop exec vitest run)',
  departmentIsolation: 'scripts/test-department-isolation.mjs',
  fixture: 'scripts/crm/local-fixture.mjs (createLocalFixture, ordinary owner, PostgreSQL 18; restart() for the cold step)',
  docThread: 'packages/api/src/application-platform/__tests__/doc-thread-cost.integration.test.ts',
}

/** The six fixed-20 scenarios, exactly as the harness names them. */
export const FIXED20_SCENARIOS = [
  'empty-private/legacy', 'empty-private/department-v2',
  'populated-private/legacy', 'populated-private/department-v2',
  'shared-room/legacy', 'shared-room/department-v2',
]

/**
 * Budgets from docs/plans/oss-chat-architecture-replacement.md section 7 and
 * the milestone discipline. `status` is `binding`.
 */
/**
 * Per-scenario fixed-20 budgets, decided by the user on 2026-11-17 (fused
 * admission adopted in production, the 999 nested-statement ceiling retired).
 * permissionWork: the fused-admission median nested statements per chat with the
 * 8294 plan-size successor, plus 20%, rounded up. latencyP50: the pre-8289 warm
 * wall-time p50 in ms (20 warm samples), because the M6 latency metric may not be
 * baselined at a regression. Source: brian-platform
 * docs/plans/evidence/oss-chat-replacement/canonical-publication/m1-fused-admission-adoption.md.
 */
export const SCENARIO_BUDGETS = Object.freeze({
  noTool: Object.freeze({
    'empty-private/legacy': { permissionWork: 11907, latencyP50: 458 },
    'empty-private/department-v2': { permissionWork: 12219, latencyP50: 474 },
    'populated-private/legacy': { permissionWork: 12130, latencyP50: 452 },
    'populated-private/department-v2': { permissionWork: 12423, latencyP50: 494 },
    'shared-room/legacy': { permissionWork: 24074, latencyP50: 544 },
    'shared-room/department-v2': { permissionWork: 22922, latencyP50: 573 },
  }),
  oneLookup: Object.freeze({
    'empty-private/legacy': { permissionWork: 12593, latencyP50: 486 },
    'empty-private/department-v2': { permissionWork: 12947, latencyP50: 503 },
    'populated-private/legacy': { permissionWork: 12816, latencyP50: 475 },
    'populated-private/department-v2': { permissionWork: 13151, latencyP50: 496 },
    'shared-room/legacy': { permissionWork: 29385, latencyP50: 617 },
    'shared-room/department-v2': { permissionWork: 27909, latencyP50: 623 },
  }),
})
export const BUDGETS = {
  foreground: { limit: 50, op: '<=', unit: 'statements', status: 'indicative', text: 'indicative target <=50 foreground SQL round trips, fixed no-tool 20-frame turn (section 7)' },
  oneLookup: { limit: 100, op: '<=', unit: 'statements', status: 'indicative', text: 'indicative target <=100 foreground SQL round trips, fixed one-lookup turn (section 7)' },
  permissionWork: {
    op: '<=', unit: 'nested statements', status: 'binding', perScenario: 'permissionWork',
    text: 'per-scenario permission-work budget: the measured fused-admission (8294) nested statements per chat plus 20% (SCENARIO_BUDGETS; decided 2026-11-17, replaces the retired 999 ceiling)',
  },
  latencyP50: {
    op: '<=', unit: 'ms', status: 'binding', perScenario: 'latencyP50', minSamples: 20,
    text: 'per-scenario warm wall-time p50 at most the pre-8289 p50 (SCENARIO_BUDGETS; decided 2026-11-17), over >=20 warm samples',
  },
  preparationP95: { limit: 500, op: '<=', unit: 'ms', status: 'binding', minSamples: 30, text: 'warm no-tool preparation p95 <=500 ms over >=30 warm samples (section 7)' },
  finalizationP95: { limit: 500, op: '<=', unit: 'ms', status: 'binding', minSamples: 30, text: 'warm no-tool finalization p95 <=500 ms over >=30 warm samples (section 7)' },
  forbiddenImports: { limit: 0, op: '==', unit: 'files+packages', status: 'binding', text: 'ordinary chat loads no optional Office/PDF/render, CRM/campaign or ingest implementation (section 7, M4 exit)' },
  d13Residue: { limit: 0, op: '==', unit: 'edges', status: 'binding', text: 'D13: zero shim edges and zero @use-brian/core root references before the root barrel is deleted (M4 step 7)' },
  modelCalls: { op: '==', unit: 'calls', status: 'binding', text: 'classifier calls per fixed turn equal the routing table (research.md "Preparation port", M3 receipt); unchanged by design' },
  outputFrames: { limit: 20, op: '==', unit: 'frames', status: 'binding', text: 'exactly 20 protected text frames admitted for the fixed workload (harness pacing)' },
  docThreadAudience: { limit: 20000, op: '<=', unit: 'ms', status: 'interim', text: 'doc-thread audience work (turnTimings.audience_check_ms) at turn 32 <=20 s, interim (Decision 10 step one; the measured 18.6 s plus spread); M7 criterion: constant per-turn cost' },
  gate: { op: 'exit 0', status: 'binding', text: 'command exits 0 on the final source' },
  journey: { op: 'all checks', status: 'binding', text: 'every scripted check passes at the stated width' },
}

/**
 * Matrix rows. `steps` names run-matrix step ids that feed the row. A row with
 * `unmeasured` has no existing harness (or only a skeleton) and reports that.
 */
export const ROWS = [
  // A. Fixed-20 HTTP workload
  { id: 'A1', section: 'A', title: 'Fixed-20 counts, OSS schema', cells: FIXED20_SCENARIOS, steps: ['fixed20-oss-counts'] },
  { id: 'A2', section: 'A', title: 'Fixed-20 counts, hosted schema (open plus api-platform migrations)', cells: FIXED20_SCENARIOS, steps: ['fixed20-hosted-counts'] },
  { id: 'A3', section: 'A', title: 'Fixed-20 warm distribution, 31 samples (sample 0 warm-up), OSS schema', cells: FIXED20_SCENARIOS, steps: ['fixed20-oss-warm'] },
  { id: 'A4', section: 'A', title: 'Transport fragmentation 20/200/2,000 provider chunks, identical bytes', cells: ['20', '200', '2000'].flatMap(n => FIXED20_SCENARIOS.map(s => `${n}:${s}`)), steps: ['fixed20-oss-frag-20', 'fixed20-oss-frag-200', 'fixed20-oss-frag-2000'] },
  { id: 'A5', section: 'A', title: 'Stale shared room reclaimed by one atomic claim', cells: ['shared-room/legacy', 'shared-room/department-v2'], steps: ['fixed20-oss-stale-room'] },
  { id: 'A6', section: 'A', title: 'Fixed-20 chat on a transferred existing brain', cells: ['transferred'], steps: ['transfer'] },
  { id: 'A7', section: 'A', title: 'Cold database (restarted cluster, fresh API process and pools; OS page cache stays warm), cold and paired warm columns', cells: FIXED20_SCENARIOS, steps: ['fixed20-oss-cold'] },
  { id: 'A8', section: 'A', title: 'Fixed one-lookup workload: one catalog tool call (mcp_call to introspection listPendingApprovals), then 20 frames (indicative foreground target <=100)', cells: FIXED20_SCENARIOS, steps: ['fixed20-oss-lookup'] },
  { id: 'A9', section: 'A', title: 'Scaling: 10/100/1,000 retained messages and 1/10/100 distinct dependencies', cells: ['messages:10', 'messages:100', 'messages:1000', 'dependencies:1', 'dependencies:10', 'dependencies:100'], steps: ['fixed20-scaling'] },
  { id: 'A11', section: 'A', title: 'Doc-thread per-turn cost: 32 dock turns on one Page session (turns 1, 2, 3, 8, 16, 24, 32); interim budget audience <=20 s at turn 32 (the measured value), M7 criterion constant per-turn cost', cells: ['1', '2', '3', '8', '16', '24', '32'], steps: ['doc-thread-32'] },
  { id: 'A10', section: 'A', title: 'Shifted costs: idle polling, held-lock waits, revision N+1, conversion, high-fanout invalidation', cells: ['idle-polling', 'lock-waits', 'revision-n+1', 'conversion', 'fanout'], steps: [], unmeasured: 'No maintained harness; the 2026-11-16 baseline took these from development-database logs (756 SQL calls per idle 10 s, 4.7 s lock waits).' },
  { id: 'A12', section: 'A', title: 'Context-aware mounted chat on the OSS schema through durable completion with an immediate provider', cells: ['sparse', 'dense'], steps: ['context-aware-chat'] },
  { id: 'A13', section: 'A', title: 'Context-aware mounted chat on the hosted schema through durable completion with an immediate provider', cells: ['sparse', 'dense'], steps: ['context-aware-chat-hosted'] },
  // B. One-turn baseline re-run
  { id: 'B1', section: 'B', title: 'One-request admission re-measurement (audience checks, admission, owner frames)', cells: ['empty-private', 'populated-private', 'shared-room'], steps: ['admission'] },
  { id: 'B2', section: 'B', title: 'Original development-data, live-provider one-turn scenario', cells: ['dev-turn'], steps: [], unmeasured: 'The original was one turn on development data with a live provider read from turn_timings and PostgreSQL logs; no maintained harness reproduces it on a disposable brain, and a personal brain is out of bounds.' },
  // C. Model calls
  { id: 'C1', section: 'C', title: 'Classifier calls per fixed routing turn at the provider boundary (13 turns)', cells: ['13 fixed turns'], steps: ['model-calls'] },
  { id: 'C2', section: 'C', title: 'Classifier counters on the fixed-20 no-tool turn', cells: FIXED20_SCENARIOS, steps: ['fixed20-oss-counts'] },
  // D. Imports and startup (M4 D13/D14)
  { id: 'D1', section: 'D', title: 'Static import graph, gated `chat` entry set', cells: ['packages/api/src/turn/kernel.ts', 'packages/api/src/routes/chat.ts', 'packages/agent-runtime/src/index.ts'], steps: ['import-graph-chat'] },
  { id: 'D2', section: 'D', title: 'Static import graph, `m4-measure` set (both editions)', cells: ['packages/api/src/turn/kernel.ts', 'packages/api/src/routes/chat.ts', 'packages/api/src/boot.ts', 'apps/api/src/index.ts', 'plat:apps/api/src/index.ts'], steps: ['import-graph-m4'] },
  { id: 'D3', section: 'D', title: 'OSS runtime module trace, workers off: loaded modules, boot time, RSS', cells: ['startup'], steps: ['runtime-trace-oss'] },
  { id: 'D4', section: 'D', title: 'OSS runtime module trace, workers on', cells: ['startup'], steps: ['runtime-trace-oss-workers'] },
  { id: 'D5', section: 'D', title: 'After-turn module delta and five activation probes', cells: ['after-turn', 'office-docx-pdf-export', 'crm-contact-create', 'campaign-draft', 'file-ingest-job', 'mailbox-tool-call'], steps: ['runtime-trace-oss'], unmeasured: 'chat-import-receipt.mjs is a skeleton: its ordinary turn and every activation probe report not-yet-run (complete:false).' },
  { id: 'D6', section: 'D', title: 'D13 residue: shim edges and @use-brian/core root references', cells: ['shimPathEdges', 'coreRootRefs', 'coreDistEdges'], steps: ['codemod-verify'] },
  { id: 'D7', section: 'D', title: 'Hosted runtime module trace', cells: ['startup'], steps: [], unmeasured: 'No driver boots the hosted entry under the trace hook; the M4 plan marks it as needing the /start-local stack.' },
  // E. Browser journeys (M5 harness) at 390x844 and 1440x900
  ...[
    ['E1', 'New chat, first send adopts the session, reload mid-turn re-attaches, follow-up', 'new-chat-reload'],
    ['E2', 'Composer clears only after acceptance', 'composer-accept'],
    ['E3', 'Stop during admission, during output, Stop failure', 'stop'],
    ['E4', 'Network loss mid-turn', 'network-loss'],
    ['E5', 'Room with two users', 'room'],
    ['E6', 'Approval live, restored, 403, teammate cleared', 'approval'],
    ['E7', 'Question answer and cancel, resumed reply without polling', 'question'],
    ['E8', 'A to B to A mid-turn, New chat mid-turn', 'switch'],
    ['E9', 'Multi-assistant response group', 'room'],
    ['E10', 'Uploads, voice note chip, draft across switch', 'uploads'],
    ['E11', 'Work Bench Live card Stop and composer Stop on a re-attached turn', 'workbench-stop'],
    ['E12', 'Workspace view first send creates the room', 'room'],
    ['E13', 'Dock D1: one live turn across presentations', 'dock'],
    ['E14', 'Dock D2: build-log replay', 'dock'],
    ['E15', 'Dock D3: dock and page on one session', 'dock'],
    ['E16', 'Dock D4: reload mid-turn re-attaches', 'dock'],
    ['E17', 'Dock D5: reset and resume', 'dock'],
    ['E18', 'Identity change isolation', 'identity'],
  ].map(([id, title, journey]) => ({ id, section: 'E', title, cells: ['390', '1440'], steps: [`browser-${journey}-390`, `browser-${journey}-1440`] })),
  { id: 'E19', section: 'E', title: 'Resume end to end (kill the API, restart, re-attach)', cells: ['1440'], steps: ['browser-restart-1440', 'browser-restart2-1440'] },
  // F. Packaged desktop
  { id: 'F0', section: 'F', title: 'Packaged desktop build (`pnpm --filter @use-brian/app-desktop package`)', cells: ['mac-arm64'], steps: ['desktop-package'] },
  { id: 'F1', section: 'F', title: 'Packaged (a): quit mid-turn and relaunch re-attaches', cells: ['packaged'], steps: ['desktop-journey-a'] },
  { id: 'F2', section: 'F', title: 'Packaged (b): offline relaunch keeps drafts and chips, nothing auto-sent', cells: ['packaged'], steps: ['desktop-journey-b'] },
  { id: 'F3', section: 'F', title: 'Packaged (c): account switch with the chat window open leaks nothing', cells: ['packaged'], steps: ['desktop-journey-c'] },
  { id: 'F4', section: 'F', title: 'Packaged (d): concurrent turns in both windows', cells: ['packaged'], steps: ['desktop-journey-d'] },
  { id: 'F5', section: 'F', title: 'Packaged (e): sleep/wake past token expiry shows no account picker', cells: ['packaged'], steps: ['desktop-journey-e'] },
  { id: 'F6', section: 'F', title: 'Packaged: desktop chat window companion phases', cells: ['packaged'], steps: ['desktop-journey-companion'] },
  { id: 'F7', section: 'F', title: 'Desktop shell harness cases (unit, not packaged)', cells: ['vitest'], steps: ['desktop-unit'] },
  // G. Existing-brain transfer
  { id: 'G1', section: 'G', title: 'Existing-brain transfer proof (embedded 8273 brain to managed PostgreSQL)', cells: ['transfer'], steps: ['transfer'] },
  { id: 'G2', section: 'G', title: 'Launcher receiving (fresh chain, witness, JWT chat across crash and cold restart)', cells: ['launcher'], steps: ['launcher-receiving'] },
  // H. Repository gates
  { id: 'H1', section: 'H', title: '`pnpm test` (platform root, includes OSS packages)', cells: ['gate'], steps: ['gate-test'] },
  { id: 'H2', section: 'H', title: '`pnpm smoke`', cells: ['gate'], steps: ['gate-smoke'] },
  { id: 'H3', section: 'H', title: '`pnpm check` (complete)', cells: ['gate'], steps: ['gate-check'] },
  { id: 'H4', section: 'H', title: '`pnpm verify:api-deploy`', cells: ['gate'], steps: ['gate-verify-api-deploy'] },
  { id: 'H5', section: 'H', title: '`@use-brian/api-open` test gate (PGlite, migration suites, runtime.test.ts)', cells: ['gate'], steps: ['gate-api-open'] },
  { id: 'H6', section: 'H', title: 'Department-isolation matrix, full profile', cells: ['gate'], steps: ['gate-department-isolation'] },
]

/** Metric definitions, keyed as collect.mjs emits them. */
export const METRICS = {
  foreground: { unit: 'statements', budget: 'foreground', text: 'pg client query() calls during the measured request, both pools, transaction/control and publication included (harness field `queries`)' },
  nested: { unit: 'statements', text: 'pg_stat_statements calls with toplevel=false between the before/after snapshots, observer excluded (`nestedSql.nested.calls`)' },
  permissionWork: { unit: 'nested statements', budget: 'permissionWork', text: 'permission-work units, counted as nested statements (the M1 receipts method); the harness states this is not complete physical permission work' },
  functionCalls: { unit: 'calls', text: 'pg_stat_user_functions call delta (excludes inlined SQL)' },
  audienceChecks: { unit: 'checks', text: '`turnTimings.audience_check_count` (the counter the 2026-11-16 baseline reported)' },
  admissionMs: { unit: 'ms', text: '`turnTimings.admission_ms`' },
  preparationMs: { unit: 'ms', budget: 'preparationP95', text: '`turnTimings.loop_started_at_ms` (warm preparation)' },
  finalizationMs: { unit: 'ms', budget: 'finalizationP95', text: '`turnTimings.flush_ms + turnTimings.post_ms` (warm finalization)' },
  sharedReads: { unit: 'blocks', text: 'pg_stat_statements shared_blks_read, top-level plus nested, between the observer snapshots (`nestedSql.topLevel.sharedReads + nestedSql.nested.sharedReads`); blocks not found in shared buffers' },
  lookupCalls: { unit: 'calls', text: 'executions of the one lookup (`lookup.calls`), with the tool result the provider received checked by the harness' },
  lookupStatements: { unit: 'statements', text: 'foreground statements issued while the lookup port ran (`lookup.statements`); concurrent statements in that window are included' },
  chatSqlMs: { unit: 'ms', text: 'summed client-observed elapsed time of foreground statements (`queryMs`); overlapping statements are summed' },
  wallMs: { unit: 'ms', text: 'HTTP request start to response end (`elapsedMs`)' },
  firstTextMs: { unit: 'ms', text: 'request start to first text_delta at the client (`firstTextMs`)' },
  docAudienceMs: { unit: 'ms', budget: 'docThreadAudience', text: 'doc-thread turn `turnTimings.audience_check_ms` (doc-thread-cost harness `audienceMs`)' },
  docTurnMs: { unit: 'ms', text: 'doc-thread turn `turnTimings.total_ms` (doc-thread-cost harness `totalMs`)' },
  outputFrames: { unit: 'frames', budget: 'outputFrames', text: 'admitted text_delta events received (`outputEvents`), separate from provider chunks' },
  modelCalls: { unit: 'calls', budget: 'modelCalls', text: 'classifier calls counted at the provider boundary by system prompt; web turns also `turnTiming` counters' },
  loadedModules: { unit: 'modules', text: 'module URLs loaded at the `startup` snapshot (module-trace-hook `loadedCount`)' },
  bootMs: { unit: 'ms', text: 'hook registration to the `startup` snapshot taken after /health 200 (250 ms poll granularity)' },
  rssBytes: { unit: 'bytes', text: 'process RSS at the snapshot' },
  staticFiles: { unit: 'files', text: 'static import closure file count per entry (import-graph `files`)' },
  forbidden: { unit: 'files+packages', budget: 'forbiddenImports', text: 'forbidden implementation files plus forbidden npm packages reached per entry' },
}
