# Project harness rollout and independent acceptance

**Release gate: OPEN — not certified for rollout.** See [implementation checklist](project-harness.md) and [architecture](../architecture/project-harness.md). No live migration, deployment, real connector task or independent browser acceptance has been performed as part of this work.

## Prerequisites and rollout order

1. Keep ordinary new-workspace shared-Project defaults unchanged. Use existing reviewed enablement/conversion; this feature neither converts legacy content nor adds Product/Component ACLs.
2. Run full fresh/upgrade replay on a dedicated local PostgreSQL **18** installation with `vector` and `pg_trgm`, using the disposable fixture runner below. It refuses inherited nonlocal database targets, creates its own cluster, uses an ordinary migration owner plus restricted `app_user`, and cleans up only that owned fixture. Do not replace this with testing against a production URL.
3. Run web/API regressions and both typechecks after native context integration. Apply additive migrations 8269 and 8270 through the normal deployment migration process before deploying consumers. Exercise workspace teardown/account deletion as well as ordinary history immutability.
4. Roll out shared-Project management and the human/QA workflow first. Require at least two independently authenticated Project-owner principals for specification authoring/review. Participants may perform their own human runs. Label observations `human_reported`, not independently collected agent screenshots.
5. Validate native registry wiring, Project-bound prompt injection and read-only task preparation against current canonical admission. The five read-only tools, native grounding and preparation pass focused local tests; deployed behavior remains a separate gate. Product/Component selection must be explicit. Verify that preparation returns arguments only and does not launch work.
6. Use the **existing sidanCode custom MCP connector**, if already authorized/configured, for coding execution. Explicitly select its runtime project/profile independently of the Brian Project UUID. For Pi verification after nested-directory/worktree implementation, separately promote [sidanCode PR #5](https://github.com/awcjack/sidanCode/pull/5) and the pinned agentbox execution-target tool through the normal reviewed deployment process. Verify the existing profile authorizes the target/Git metadata and RPC inspection; umbrella profiles may require the operator-only `SIDAN_PI_REPOSITORIES` mapping. No new harness runtime configuration, Docker image, fixture provisioner or reaper is supplied or required; the superseded implementation is removed.
7. Complete the independent human browser checklist against the deployed build. Record build, approved specification revision, human executor/session provenance, observations and failures. A repaired/new build requires a fresh acceptance attempt. Agent run creation remains unavailable (503); do not substitute a connector turn or Sidan auto-review for this gate.

## Reproducible local commands

From the repository root, with installed dependencies:

```sh
corepack pnpm --filter 'app-web^...' run build
corepack pnpm --filter @use-brian/api typecheck
corepack pnpm --filter app-web typecheck

corepack pnpm --filter @use-brian/api exec vitest run \
  src/project-harness \
  src/turn/__tests__/prepare.test.ts \
  src/routes/__tests__/project-harness.test.ts \
  src/routes/__tests__/project-harness-execution.test.ts \
  src/db/__tests__/project-harness-persistence.test.ts \
  src/db/__tests__/project-harness-store.test.ts \
  src/db/__tests__/project-harness-execution-persistence.test.ts \
  src/db/__tests__/project-harness-execution-store.test.ts --maxWorkers=1

corepack pnpm --filter app-web exec vitest run \
  src/lib/api/__tests__/project-harness.test.ts \
  src/components/projects/__tests__/project-harness.test.tsx \
  src/lib/offline/__tests__/durable-draft.test.tsx \
  src/lib/offline/__tests__/surface-content-lease.test.tsx --maxWorkers=1

node --check scripts/project-harness/verify-postgres.mjs
```

The API command includes native prompt/MCP tests under `src/project-harness`. Also run the existing `workspace-mcp` catalog/consent/native-turn and `context-scope` execution-context/authority-lease/resolve-turn-scope suites. Focused local results and both successful typechecks are recorded in the plan; these are not deployed connector or browser certification, and old runtime-era totals are not current coverage.

Real PostgreSQL gate (**not executed here**):

```sh
node scripts/project-harness/verify-postgres.mjs --pg-bin /path/to/postgresql18/bin
```

This creates two ordinary-owner disposable clusters: fresh full historical replay, and full replay with a pre-8270 hierarchy/history seed whose identity/content must survive the upgrade. The integration suite tests real JWT/session middleware, independent owner governance, stale heads, concurrent claims, membership/session revocation and run/session expiry during observed lock waits. Retained trusted SQL agent commands remain testable without an agent runtime. Typechecking the suite is **not** passing execution. Additional deployment-specific contention/recovery tests remain required.

## Native context and connector acceptance checklist

These are validation gates, not a declaration that external integration is complete:

- Confirm the native tools are registered through the canonical registry/executor/MCP projection, not a parallel bypass. Caller identity comes from authenticated host context, not arguments or a billed owner. Live admission and the internal Project scope floor must be retained.
- In a Project-bound native session, inspect the injected Project-level contract. Select a Product/Component explicitly and read the corresponding effective context; do not infer scope from names in prose. Confirm no sibling-local rules or unauthorized source bodies enter it.
- Verify `prepareProjectHarnessTask` returns exact `new_task_with_context` arguments using canonical constraints and the explicit selected scope. Require an explicit `brianTaskId` for a current actor-readable Task in the selected Brian Project. Forward it unchanged at the top level. Require `runtimeProject` separately from the Task and Project UUIDs; `product` must be the actual Product name (omitted for Project scope), not an invented ID string or automatic directory switch. Unknown/mismatched runtime project/cwd must be handled by existing Sidan runtime policy, not by guessing or creating a Brian-to-runtime mapping.
- Supply `changedSources` OR impacted `scopes` (defaults to the coding scope). Confirm one snapshot supplies implementation lineage and the full impacted coding/test plan in `context.constraints`, with selected checks/scenarios, revision origins, criteria and reason paths. Backend changes should select declared reverse-dependent Frontend tests, not their local implementation rules. The explicit coding scope must be covered. Unmapped/archived/unresolved/conflicted plans return blocked with no task arguments.
- Inspect prepared context for plan ID, provenance and actual unit/integration/contract test obligations. Fail closed on unavailable authority/oversized context rather than dropping rules/tests to fit. Preparation must not execute checks, start an external task, approve a revision or write results/evidence.
- If an operator separately authorizes a real connector test, invoke the existing connector with reviewed arguments and inspect task/events. `new_task_with_context` returns a task ID; native turn completion is not acceptance. Wait for `active: false` before continuing.
- Do not assume durable external task/scope/selection binding or refresh on `send_message`: both are **not implemented**. Re-read current canonical context before relying on an old external snapshot; automatic refresh remains a roadmap item.
- Do not post a model report as trusted evidence. MCP report/evidence submission and automatic harness-driven external dispatch are **not implemented**. Trusted SQL/store agent commands are not exposed MCP tools. Verify agent REST run creation returns `503 harness_agent_runtime_unavailable` without persisting a run, and no dispatch route remains.
- The prepared nonempty `context.verification` requests Sidan's existing review after a successful implementation turn. Verify the review receives the same canonical impact plan and reports commands/outcomes per check and evidence/status per scenario criterion. Missing environment/evidence is blocked or inconclusive, not passed. Check `spawned_review_id`, then the review task status/output; failed review startup must not count as verified work. Sidan spawns at most one review per implementation task, not on every continuation. With companion Sidan PR #5, require a fresh execution-target report and confirm the new Pi review session uses the validated implementation worktree/product directory with the same authorized profile and no resume. Test missing/failed/foreign/stale targets: no fallback to the initial cwd, new mounts or recreated checkout. Confirm it is described honestly: shared implementation context/output and working-tree access, **not source-blind or independent browser acceptance**. MCP connectivity establishes no sandbox property.

### Credentials and human approval remain unchanged

Use the existing reviewed connector credential configuration and the deployment's existing Sidan runtime/project allowlist. Do not place secrets in definitions, prepared context, prompts or logs. Task-control credentials cannot answer human approval requests; the separate interaction credential must not be registered as an MCP credential. The optional host-side relay retains its exact live-request binding and existing human decision path. Harness revision approval is separate from an action approval. Completion workflow notifications are turn outcomes, not harness evidence. This work neither provisions credentials nor changes or deploys the relay.

## Independent human browser checklist

Give this section, the deployed URL, immutable build identity and authorized test accounts to a reviewer who did not implement the feature. Use a separately controlled test session and known test data. Do not send implementation transcripts or explanations as substitutes for observable evidence. If independent review or the environment is unavailable, record **blocked**, not self-reviewed acceptance. This checklist is manual; no harness-owned browser/fixture service exists.

Use author-owner A, separate reviewer-owner B, participant QA C, workspace-owner oversight D who is not a Project member, and outsider E.

| Journey | Actions and required observable evidence |
| --- | --- |
| Hierarchy | A creates Frontend/Backend Products and Calendar Picker/Logo Components. Navigate, reload and verify ancestry persists. Capture hierarchy plus revision. |
| Inheritance | A adds a Frontend default and Project invariant. Calendar explicitly specializes the default. Verify origin/revision labels and conflict messages; weakening an invariant must not silently resolve. |
| Sibling isolation | Add a Calendar-local width rule. Open Logo and verify neither effective rules nor definition include it. Capture both views. |
| Concurrency | Edit one definition in two sessions. Save one, then attempt the older revision. Verify conflict, preserved authored draft and no silent overwrite. Changed-base recovery must not silently rebase. |
| Offline recovery | Edit, disconnect, switch scopes/reload/reconnect. Recover only the correct viewer/workspace/Project/scope draft. Failed save preserves it. Sign in as another principal: no prior protected content/draft displayed. |
| Background renewal | Keep a rename dialog open across lease renewal. Unchanged renewal preserves typing. Revoke access or change the node: dialog closes and cannot later mutate under another identity. |
| Archive | Archive Product then attempt child edits/run creation; writes blocked, history readable. Restore parent before child. Existing results cannot change. |
| Review independence | A cannot approve A's revision; B approves the exact reviewed head. Change the head and verify old approval cannot start or continue a run. |
| Human checklist | C creates a run with build/environment identity, follows preconditions/steps, records per-criterion observations and completes all criteria. Missing criteria/evidence cannot pass. Evidence is visibly human-reported. |
| Run ownership | B reads C's run but cannot submit C's observations/results or cancel it. C can act while authorized. Failed governance actions do not hide still-readable content. No agent-dispatch action is offered. |
| Access boundary | C reads but cannot edit definitions/approve; D oversight reads but cannot govern/run; E sees not-found/no content. Disable shared capability/quarantine and verify denial. |
| Mid-session revocation | Revoke requester membership/session or downgrade B's clearance while a run is active. Subsequent actions/evidence/result publication must be denied. Read leases remove protected UI content after authoritative denial. |
| Responsive/locales | Repeat navigation/editor/recovery/checklist at 360px, tablet and desktop, with keyboard/touch targets, in en/zh/zh-cn/ja. No overflow or inaccessible essential actions. |
| Impact escalation | Using an independently authorized repository, select a Calendar-owned change: its checks and ancestor scenarios, not Logo-local rules. Change a Backend contract: select declared reverse-dependent Frontend acceptance with reason paths. Unmapped changes show blocked/uncovered. Selection itself does not execute tests. |

## Future automated acceptance gate

No automated browser executor is delivered by this context architecture. Before adding one through an external integration, independently define and validate authority, approved specification/build binding, isolated test state, source/transcript access policy, permitted tools/network, evidence provenance, cancellation/expiry/revocation and cleanup. Test missing/foreign criteria, replayed evidence and ambiguous outcomes; none may yield passed. A fresh session, an MCP connection, a configured endpoint or Sidan auto-review alone satisfies none of these gates. Do not expose retained owner-only SQL agent commands to models to bypass this work.

## Stop/rollback procedure

If admission/context/approval checks fail, stop rollout and roll back affected consumers while retaining additive schema/history. Stop initiating external coding tasks through normal connector controls if that integration is implicated; disabling a connector does not prove already-started tasks stopped. Use its existing task status/interruption and human approval procedures, not removed harness cleanup scripts. Preserve run/evidence/audit records for investigation. Do not perform destructive down-migrations or remove task state to force uncertain retries. Use existing shared-Project capability governance only when its broader access effect is intended.
