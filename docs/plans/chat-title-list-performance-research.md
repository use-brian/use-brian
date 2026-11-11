# Chat title-list performance: research and fix plan

## Status and scope

Research and implementation against `develop` at `74a836f2f` (the worker credential/timeout fix from PR #484 is merged), on `feature/chat-title-list-performance`.
The research snapshot below motivated additive migration `8258_native_private_title_proof.sql` and an optional identity-only acquisition path. Implementation measurements and reproduction instructions follow the research sections.
No existing database was migrated, no services were restarted, and no jobs were requeued. Synthetic writes and function-statistics configuration changes were confined to marker-verified disposable PostgreSQL 18 fixtures. Read-only catalog/ancestry inspection also used the existing local database.

The target is database work and lock-holding time in saved-title reads, not title wording, generation cadence, or reduced Memory functionality. Do not weaken authorization or reuse admission across freshness boundaries.

## Measured results

The earlier local diagnostic measured a single personal saved title at 1.7–2.0 seconds / 229 SQL statements; worker-authority transcript reads were 27–36 ms. The saved title's ancestry included both old field-backed history and newer `private_transcript` observations.

The disposable reproduction used genuine native browser credentials, canonical private transcript capture, current Memory index/search, canonical reply publication, and canonical title publication. A second title revision additionally consumed a real, independently admitted field-backed history capture. Every fixture conversation contained just **two messages**.

Three measured rounds followed a warm-up for each case:

| Saved-title ancestry | Memory rows | Elapsed ms (three rounds) | SQL statements per round | Tracked PG function calls per round |
| --- | ---: | --- | ---: | ---: |
| Private dialogue + current Memory query evidence | 0 | 266 / 254 / 252 | 229 | 8,293 |
| Same, plus field-backed history | 0 | 963 / 958 / 946 | 229 | 64,738 |
| Private dialogue + current Memory query evidence | 1 | 481 / 472 / 470 | 231 | 19,100 |
| Same, plus field-backed history | 1 | 1,875 / 1,868 / 1,862 | 231 | 114,993 |

The populated case actually retrieved the synthetic Memory fact. The mixed empty case had six application-field nodes; the mixed populated case had eight, including current Memory query fields. These are local diagnostic timings, **not production percentiles or established latency SLOs**. Function counts come from `pg_stat_user_functions`; inlined SQL functions are not necessarily represented.

### Dominant work

Third warmed mixed-title reads:

| Top-level SQL operation | Calls | Empty Memory total ms | Populated Memory total ms |
| --- | ---: | ---: | ---: |
| `read_native_session_field_dependencies` | 4 | 382 | 886 |
| `read_native_session_field_snapshots` | 2 | 204 | 465 |
| `read_native_empty_query_session_title_revision` | 1 | 197 | 341 |

Together these statements consumed approximately 83% / 91% of measured elapsed time. Nested PostgreSQL function totals overlap; they must not be added to these statement totals.

The populated mixed case executed 1,122 `application_scope_lineage` calls, 410 `application_memory_query_context` calls, and 128 `application_session_eval_field` calls. Merely having the same 231 client statements does not mean the database is doing the same amount of work.

Standalone `EXPLAIN (ANALYZE, BUFFERS)` of the mixed-empty operations, under a fresh genuine app-role frame, showed:

- Dependencies: 96 ms, 8,587 shared buffer hits, zero shared reads.
- Snapshots: 101 ms, 9,132 shared hits, zero shared reads.
- Title payload reader: 196 ms, 23,611 shared hits, zero shared reads.

This points to repeated cached-data validation/computation, not demonstrated disk I/O. It does **not** establish that every nested query has an ideal plan; inspect nested plans before prescribing an index.

All twelve top-level optional native-evidence probes returned `null` on each measured title read. They cost approximately 67–76 ms combined. Avoiding unsupported probes alone would not resolve the mixed-history bottleneck.

## Why the work repeats

The individual saved-title path is:

1. `routes/session-title-authority.ts:198–217`: metadata-only candidate discovery, genuine per-row authority resolution, and head identity pinning. No title payload is admitted here.
2. `:247,264`: a singleton deliberately does not enter optional grouping.
3. `:311–313`: `readSessionTitle` acquires the current pinned revision under a retained non-owner frame.
4. `db/session-context-revisions.ts:458–461`: caller/source validation precedes `read_native_empty_query_session_title_revision` inside that frame.
5. `routes/session-title-authority.ts:316`: a **separate fresh output/audience validation** runs at collection.

Each full fallback validator performs initial field-ancestry validation, current-source snapshots, then a final ancestry-footprint recheck (`context-scope/caller-evidence.ts:245,337,358–365`). Two complete validators explain the observed **four dependency calls and two snapshot calls**. They are not four accidentally duplicated list rows.

Output also tries a native-only invocation frame before its general fallback (`application-platform/model-source-authority.ts:57–61`). With caller acquisition, that produces three optional proof ladders, each of four unsuccessful probes (`application-platform/native-session-evidence.ts:52–59`).

The generic admitted field-dependency reader validates every field separately (`migrations/8011_application_derivation_and_fields.sql:611`). A mixed source closure falls back to this path when the current native dependency reader cannot establish its complete proof. This is where nested field/Memory/lineage work multiplies. The native field readers already contain additional planning lanes from migrations 8244/8245; do not assume there is no existing batching or memoization to preserve.

## Profile mismatch: private transcript ancestry

The inspected slow local title contained two `private_transcript` nodes, four message query fields, two Memory query domains, message/annotation domains, and their message/domain/title ancestors. The isolated mixed cases reproduced the mismatch with one transcript observation.

`private_transcript` was introduced by migration 8234. Existing closed native proof families still reject this kind in their permitted closure sets:

- Turn metadata acquisition returns `unsupported_source_kind` on its semantic frontier (see the compact-requirements transition in `migrations/8199_native_turn_compact_requirements.sql`). It also has separate title-parent eligibility restrictions; adding one source-kind string would not make it a general title reader.
- The file worklist proof rejects kinds outside its closed set (`migrations/8167_native_evaluator_worklist_transport.sql:813–822`).
- The attended Memory/cohort and empty-query proof families likewise retain closed source-kind profiles.
- TypeScript proof packet schemas also exclude `private_transcript` (`application-platform/native-session-evidence.ts:5–8`, `native-title-group-evidence.ts:8–10`).

This explains an eligibility gap, **not permission to treat the unknown source as admitted**. All inspected helper contract guards returned true; a broken helper fingerprint is not required to reproduce the fallback.

The transcript source is a distinct purpose: earlier utterances, not renewed factual authority for their upstream sources. Its canonical reader checks membership, session binding, recording/privacy and message holds, missing messages, and manifest fingerprints under locks (`migrations/8234_private_transcript_continuity.sql:28–55`). The authored source gate additionally restricts the owner and excludes application/public-share readers (`:167–173`). Preserve those checks and the utterance-versus-current-fact distinction.

## Existing singleton/grouping limitations

A simple `2 → 1` group-size change is **not** a sufficient fix:

- TS and SQL enforce independent group-size bounds.
- `native_personal_title_group_acquisition` currently requires both workspace-file ancestry and a Memory query-domain profile (`migrations/8165_native_personal_title_acquisition.sql:111–125`). Neither measured mixed case had file ancestry.
- Group proof packet parsing still excludes transcript sources.

There is nevertheless a useful architecture pattern: a private identity-only acquisition operation obtains payload **and a fresh complete proof**, and the original caller validator consumes that proof in the same frame. Output remains a separate fresh operation. See `db/session-context-revisions.ts:210–221`, `context-scope/caller-evidence.ts:416–426`, and `native-personal-title-groups.integration.test.ts:107–115`.

## Recommended fix sequence

### 1. Establish a durable current-contract performance regression

Add the four reproduced ancestry/Memory cases to an isolated integration suite, including actual title equality, revision identity, bound sources, and current Memory retrieval assertions. Measure actual browser list DTOs as well as the projection helper. Keep statement counts, tracked function counts, per-stage durations, and lock spans separate.

The existing `native-chat-read-cost.integration.test.ts` **currently fails during setup at line 112**, expecting one annotation from `readAdmittedSessionQuery`; native private-history queries intentionally return an empty annotations array. The targeted test never reaches its profile. Do not simply change that assertion: several later tests are specifically about canonical field-backed history and old source-withdrawal behavior. Separate private dialogue tests from intentionally canonical field-history tests so neither purpose disappears.

### 2. Optimize complete current validation for the measured mixed profile

First prototype a narrowly scoped complete title/native-field proof for personal native chats whose closure contains private transcript evidence plus supported current native field/Memory evidence. Investigate extending the existing detached/worklist evaluator rather than introducing a new authorization engine.

Required properties:

- The database independently discovers the entire original closure and all current Memory query obligations.
- Transcript nodes are authenticated through the existing canonical owner-bound reader, not raw observation metadata or a caller-supplied descriptor.
- Work can be shared **only within the fresh database operation**, with its original context, lock plan, version/label checks, graph bounds, cycle handling, and final footprint checks.
- Do not globally allow transcript nodes by adding whitelist entries without implementing their validation, current-state treatment, and proof descriptors.
- Unknown, external, historical, Page, changed-helper, and unsupported Memory profiles retain their complete existing fallback.
- Both caller acquisition and final output obtain their own fresh proof.

Prototype this in a disposable fixture and compare complete projections/evidence with the unchanged reader. At research time no speedup had been measured; the subsequent narrow implementation results are recorded below. If support requires a broad kernel rewrite, stop and narrow the profile or optimize the canonical fallback instead.

### 3. Consolidate singleton acquisition-side proof work

Once the measured closure has a complete efficient proof, introduce an optional single-title identity-only acquisition analogous to the existing group port. Use the original scalar-floor validation and pre-payload SQL-access-versus-caller-ceiling containment check. Return the exact pinned session/revision and bound sources; keep final output validation separate.

This removes repeated acquisition-side work rather than deleting freshness checks. Broadening existing group behavior is optional and should not be a prerequisite.

### 4. Address secondary costs separately

- Batch compatible principal/metadata queries without treating equal contexts as interchangeable live leases. This matters more with non-local database latency.
- Consider a short lock-wait budget for optional list-title reads only, with actual cancellation/rollback and whole-page withholding. This protects tail latency but does not remove CPU work.
- Do not add unbounded parallel per-row reads; existing serialization protects the connection pool during lock contention.
- Do not remove or silently defer Memory retrieval, cache authorization across requests, or ship the previously rejected Memory-worklist SQL experiment without new evidence.

## Required verification before shipping

Correctness matrix:

- Native personal chat: no Memory, populated Memory, direct private dialogue, mixed field-backed history, and longer conversations.
- Same canonical title/revision/evidence as fallback; unchanged request order, repeated IDs, and independent-row behavior.
- Transcript edit/delete/hold, session binding changes, recording holds, membership/device withdrawal, and original ceiling contraction.
- Current Memory edit/delete/hold/growth and genuine Memory history/retraction. An old utterance is not a fresh fact; a direct current-Memory title dependency must remain current.
- Head replacement before acquisition and in the acquisition/output gap; source changes while another row blocks.
- External source context/delivery receipts, mixed unsupported families, malformed/missing/changed helper contracts, and private helper ACLs.
- Abort/authority loss, query cancellation, connection release, and entire-page withholding on `57014`/`55P03` without per-row retries.

Existing suites to preserve: `session-title-routes`, `session-title`, `native-personal-title-groups`, `native-empty-query-session-evidence`, `stored-context-model`, `private-transcript`, and caller-evidence integration suites, plus route title unit tests. These were inspected during research and subsequently exercised during implementation; verification results are recorded below.

Extended performance acceptance should include 1/10/50 sessions, message/ancestry growth, empty and populated Memory, cold/warm runs, and concurrent publication. Use deterministic database-work budgets in CI; report latency distributions and lock spans separately. The initial prototype goal—at least halve tracked work in both mixed fixtures without changing admitted evidence—is now measured below. This does not establish unsupported-family latency or large-page performance budgets.

## Research evidence and limits

Session-local scratch artifacts (outside the repository):

- `/tmp/brian-title-performance-summary.json`: compact timing/function-count evidence.
- `/tmp/brian-title-synthetic-profiles.json`: all twelve measured rounds, statements, and per-function deltas.
- `/tmp/brian-title-hot-query-plans.json`: app-role EXPLAIN results.
- `/tmp/brian-title-perf-research-synthetic.log`: synthetic setup lineage and run output, including disposal.
- `/tmp/brian-title-fixture-vitest.log`: existing benchmark setup failure.
- `/tmp/brian-title-perf-research.mjs` and `/tmp/brian-title-synthetic.mts`: disposable diagnostic runner/scenario (scratch harness, not a supported repository test).

The research did not establish production percentiles, an index audit, or large-page/cold/concurrent latency distributions. Those remain follow-up validation, not claimed results. The implementation below adds a source-mutation differential and measured singleton speedup without removing the distinct acquisition/output checks.

## Implemented narrow proof

Migration `8258_native_private_title_proof.sql` adds two identity-only public ports:

- `read_native_private_title_acquisition(workspace, session, revision)` returns the exact title payload plus a complete proof.
- `read_native_private_title_evidence(workspace, revision)` obtains a new complete proof at output; it receives no acquisition proof or memo.

Only an owned, personal native web chat with the exact current title head and a supported private/current-Memory closure is eligible. Application, shared/public, external, Page/file, historical and unsupported Memory profiles retain the original fallback. The entire graph remains present (4,096 nodes / 16,384 edges); private leaves are never filtered out or converted into speculative native allow entries.

Once metadata eligibility is established, workspace SHARE precedes head/session/transcript locks, including the independent output call; a two-connection regression verifies that publishers do not encounter inverted head/workspace locking. An additive private frame canonically admits transcript manifests, ownership, labels, binding and holds before and after evaluation. The unchanged detached field evaluator receives one operation-local memo, with the original bounded current-Memory statement builder, policy/context checks, candidate cohort, locks and finish checks. Final ordinary/private snapshots are also reread independently through `read_admitted_native_scope_snapshot`.

Installation authenticates the canonical transcript helpers' bodies and complete normalized catalog metadata before pinning. Runtime guards fingerprint full `pg_proc` rows, including owners, ACLs, language, configuration and bodies; identity ports authenticate the guard before invoking it. Internal helpers have no application-role execute grant.

A direct transcript edge is a metadata-only acquisition eligibility hint; titles without one retain original acquisition without opening a speculative frame. Indirect-only private ancestry can still use a complete fresh output proof. The hint never admits bytes: SQL rediscovers the full closure. The existing caller validator checks original scalar/source floors and the resulting proof. Acquisition is permitted only when SQL access is contained by the original caller ceiling. Existing transaction, lease, cancellation, rollback/release and workspace-lock behavior remains in force. Final output is a separate committed frame, never cached acquisition permission. Wrapped output-proof timeouts are recognized through a bounded private cause chain so `57014`/`55P03` still discard every provisional title on the page.

## Implementation measurements

The durable test is `packages/api/src/application-platform/__tests__/native-private-title-performance.integration.test.ts`. It creates the four genuine two-message scenarios above, compares exact title/revision/bound-source projections and the authenticated browser DTO, and disables **only the new guard** to obtain unchanged canonical fallback.

One warmed local diagnostic run with the independent canonical finish check:

| Ancestry | Memory rows | Canonical / native elapsed ms | Canonical / native SQL statements |
| --- | ---: | ---: | ---: |
| Private dialogue + current Memory | 0 | 266 / 161 | 285 / 154 |
| Same + canonical field history | 0 | 959 / 207 | 285 / 154 |
| Private dialogue + current Memory | 1 | 483 / 186 | 287 / 154 |
| Same + canonical field history | 1 | 1,893 / 237 | 287 / 154 |

In separate warmed tracked-work samples, mixed empty Memory fell from **64,777 to 6,745** function calls; mixed populated Memory fell from **115,024 to 8,709**. The canonical side includes optional acquisition discovery before falling back, so its statement count is higher than the pre-change 229/231 research baseline. Against that pre-change baseline, 154 statements is about one-third fewer, not a claimed 46% reduction of the original path. SQL-function inlining and overlapping nested timings retain the limitations noted above.

CI assertions require four canonical dependency reads / two snapshot reads, versus none on the admitted fast path, exactly one acquisition plus one independent output port, and lower statement count. Function profiling is enabled by default and requires at least a 50% reduction in both mixed cases; wall-clock values are diagnostic only. This is a singleton/local result, not a 50-session or production latency claim.

Reproduce on a PostgreSQL 18 installation with pgvector/pg_trgm:

```sh
node scripts/crm/local-fixture.mjs --pg-bin /path/to/postgresql-18/bin -- \
  node packages/api/node_modules/vitest/vitest.mjs run --root packages/api \
  --config vitest.integration.config.ts \
  src/application-platform/__tests__/native-private-title-performance.integration.test.ts
```

The suite verifies the disposable marker before database access or profiling configuration. To omit only the tracked-function gate, launch the child command through `env NATIVE_PRIVATE_TITLE_PROFILE=0 node ...` after the fixture runner's `--`; its sanitized environment intentionally does not inherit arbitrary outer variables. It covers Memory edit/delete/hold/growth and fresh index contents, historical utterance continuity, transcript edit/delete/hold, exact session/head binding, helper-body/volatility/ACL drift, private-helper access, narrowed original ceilings, credential revocation, head replacement, publisher/output lock ordering, non-private acquisition fallback, and actual database timeout/release behavior. It does not relax the older stale cost-suite setup or change title cadence/content.

### Broader verification and baseline failures

- **24/24 new integration tests passed** against genuine, fully migrated PostgreSQL 18 disposable fixtures, including both deterministic tracked-work gates.
- **78 unit tests passed**, including caller evidence, private proof parsing/scalar floors/timeouts, route collection, both workers, and private job credential continuity.
- Six existing integration suites passed **108 tests**: `native-empty-query-session-evidence` (22), `native-personal-title-groups` (24), `private-transcript` (30), `stored-context-model` (4), `caller-evidence` (23), and `native-session-evidence` (5).
- The two older title suites passed 22 tests and failed nine. The same nine were reproduced using unchanged `develop` (`74a836f2f`) API source in a separate worktree against the same disposable database. Five concern preview/doc-thread expectations in `session-title-routes`; four fail while constructing the external-source fixture, before title publication, in `session-title`. No assertions were relaxed and no unrelated authorization/preview changes were folded into this fix.
- The full API TypeScript check and `git diff --check` passed. The nine baseline failures mean the broad integration invocation is **not all green**; they are separate from the new targeted regression suite.

No large-page or production percentile claim is made.
