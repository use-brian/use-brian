# Harness source-evidence race: candidate repair, not acceptance

## Checkout and scope

- Implementation: `/workspace/brian/use-brian-project-harness`
- Branch: `fix/harness-source-evidence-race`
- Base commit: `f3a3bd5e36dfb4a896e5428a22caaa81fe3852ad`
- Candidate repair only; committing/pushing this branch does not establish acceptance.
- No deployment, connector call or external coding task was performed.

## Implemented admission contract

Source, native audience and native combined-output admission use bounded optimistic
candidates. Each candidate performs a fresh authorization operation for a detached
complete evidence snapshot, retaining all existing lease/canonical/source checks.
A successful candidate whose snapshot was superseded cannot release output: its
proof is discarded and the full current evidence is freshly admitted. No thrown
permission/lease/database error is retried; errors and concurrent refusal remain
sticky. Churn is limited to 32 candidates, after which admission fails closed.
Cancellation is checked before candidates and after successful awaited proofs.
This does not cancel an underlying hung database/connector operation.

Successful superseded proofs can discover stricter canonical labels. Those label
floors are retained before revalidation, without merging stale source pointers
that could regress a concurrently advanced native revision. Existing synchronous
high-water notes, failed-read floors, immutable-source conflict detection, ACLs,
ceilings, consent filters and result evidence ingestion are unchanged. No lock is
held across tools, approvals or database awaits.

## Important unresolved requirements

This is **not a completed engine-wide scheduling fix**:

1. Native publication preparation and synchronous assembly fences remain strict
   snapshot fences. Evidence arriving during preparation can still cause a sticky
   refusal. A final assembly fence must not simply be removed.
2. Kernel combined-output receipts have awaited handoff fences after the admission
   returns. A writer at that later boundary can still cause a fail-closed refusal.
   Fresh candidate admission inside the validator does not eliminate that window.
3. Eager tools still run through their existing invocation/effect authority. This
   patch does not quiesce active tools or establish a new execution/effect-boundary
   scheduling contract for shared evidence. The stronger requirement about tool
   effects under newly raised evidence needs further design and verification.

These were identified by a read-only review. No independent acceptance is claimed.
Do not resolve these remaining windows by skipping fences or retrying authority
errors. A synchronous admitted continuation / safe-point contract may be needed
for the final handoff, with separate handling of parked approvals and tool effects.

## Deterministic evidence

`packages/api/src/application-platform/__tests__/model-source-evidence-race.test.ts`
uses real accumulators and execution contexts, deferred proof barriers and mocked
native/canonical database admission (no database or paid model). The expanded
suite has 57 passing tests covering ordinary/native/combined admission,
identical evidence, fresh complete-floor proofs, canonical floor retention, native
pointer preservation, lease/recipient refusal, concurrent sticky denial,
cancellation and bounded churn.

One test in that API suite uses the real query loop and executor with the actual
source guard: a tool raises a previously absent Project floor while a native proof
is suspended and its store read remains blocked. The stale candidate releases no
event; a fresh proof sees the floor before streaming resumes; successful result
evidence and the final output are also admitted. The exact integrated test was
run against original commit `f3a3bd5e36dfb4a896e5428a22caaa81fe3852ad` in a
detached baseline worktree: it failed (`expected 'settled' to be 'fresh'`). The
same command against the implementation passed (1 passed, 56 filtered out):

```sh
corepack pnpm --filter @use-brian/api exec vitest run \
  src/application-platform/__tests__/model-source-evidence-race.test.ts \
  -t 'freshly admits overlapping thinking' --maxWorkers=1
```

The test-only baseline worktrees were removed afterward. An initial `/tmp`
baseline attempt failed dependency collection and did not execute tests; the
successful baseline execution used a worktree under `/workspace/brian` and
unchanged installed dependencies.

`packages/core/src/engine/__tests__/query-loop.eager-output-evidence.test.ts` adds
4 engine integration tests for one/parallel tools, parked approvals and sticky
errors. Its callback models candidate admission; it is not a substitute for the
API guard test. Nested-loop scheduling and active-tool cancellation are not newly
established by these tests. Existing harness tools tests cover failed/oversized
read floor retention; the new admission tests model that retained boundary state.

## Verification commands

From the selected checkout:

```sh
corepack pnpm --filter @use-brian/api exec vitest run \
  src/application-platform/__tests__/model-source-evidence-race.test.ts \
  src/application-platform/__tests__/model-source-diagnostics.test.ts \
  src/project-harness --maxWorkers=1

corepack pnpm --filter @use-brian/core exec vitest run \
  src/engine/__tests__/query-loop.eager-output-evidence.test.ts \
  src/engine/__tests__/query-loop.model-input-authority.test.ts \
  src/engine/__tests__/tool-executor.test.ts \
  src/engine/__tests__/tool-executor-clearance.test.ts --maxWorkers=1

corepack pnpm --filter @use-brian/core typecheck
corepack pnpm --filter @use-brian/api typecheck
git diff --check
```

Final results: API **297/297**, core **109/109**; both typechecks and
`git diff --check` passed. The baseline integration test failed against the
original commit and passed against this implementation as described above.

## Environment / unexecuted gates

The handed-over `/tmp/brian-postgresql-local.DT5qKe` directory is absent here.
Health probes for ports 3003 and 14000 cannot connect; port 18080 responds 200.
No recovery, restart or replacement database was attempted. A new explicitly
authorized disposable environment is needed before browser verification.

Not executed: rebuilt browser reproduction, actual native tool output/name
verification, inherited-origin/cross-Component context checks, live revocation,
PostgreSQL18 fresh/upgrade/concurrency runner, external coding/execution-target/
fresh-review acceptance. Unit revocation tests do not constitute live revocation
verification. No tracing was enabled; the absent environment's tracing state
cannot be independently confirmed. Credentials were not read or exposed; no
unrelated database/service was modified.
