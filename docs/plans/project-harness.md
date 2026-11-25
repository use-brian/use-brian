# Project harness: implementation plan

Status: **context-first integration in progress; not release-complete**. Hierarchy, inheritance, management/review/human runs, impact planning, four context/selection read tools and read-only task preparation are implemented. Native registry wiring, consent-filtered MCP projection and Project-bound prompt injection are implemented and focused-tested. Coding execution reuses the existing sidanCode MCP connector. The superseded custom Docker runtime, fixture provisioner, dispatcher and reaper are removed, not optional deployment prerequisites. See [architecture](../architecture/project-harness.md) and [rollout/acceptance checklist](project-harness-rollout.md).

## Agreed design

- One existing Project contains Products (managed surfaces such as Frontend and Backend); a Product contains bounded Components (such as Calendar Picker).
- Products and Components inherit their Project's access boundary, not a new ACL system. Initial rollout is **shared Projects only**. Legacy Projects and new-workspace defaults remain unchanged; enabling/converting shared Projects uses existing reviewed governance.
- Project direction remains in the existing Brief. Harnesses are engineering contracts, not another authoritative Brief. Referenced documents/repositories retain their own authorization; do not expand source bodies automatically.
- An effective harness includes only applicable Project, Product and target Component rules. Sibling instructions do not inherit. Explicit dependency references are not permission to import sibling bodies.
- Invariants cannot be weakened. Defaults require explicit specialization. Local rules apply only at their exact scope. Rules/checks/scenarios retain origin and revision; structural resolution cannot detect all semantic prose contradictions.
- Coding agents must implement and run actual unit/integration tests for changed behavior through ordinarily authorized tools. Code-check instructions and acceptance scenarios are not executed by the context layer; planning, prose and mocks alone are not substitutes for tests.
- Test ownership and selection differ: component changes can select ancestor and reverse-dependent cross-product tests without inheriting their rules. Uncovered changes/conflicts block structural readiness, not merely disappear from a plan.
- Brian Project UUID and sidanCode runtime project/profile name are distinct. Native Project context may default to project scope; Product/Component selection must be explicit, not inferred from prose.
- Acceptance approval and run evidence remain independent server records. A live human owner other than the revision author approves; manual human/QA checklists retain build/scenario/evidence binding. Agents cannot self-approve or publish results through MCP.
- MCP is a transport, not a sandbox or source-blind guarantee. Sidan's verification-triggered review shares the checkout/context and receives implementation output; a fresh review session alone is not independent browser acceptance.
- Results distinguish passed, failed, blocked and inconclusive. Missing environment, evidence or independent acceptance is never a pass. Repairs require a fresh acceptance attempt against the pinned specification and new build.

## Delivery phases and TODO

### Phase 1: bounded backend foundation (implemented)

- [x] Strict Product/Component/definition/check/scenario contracts and deterministic provenance-preserving inheritance/conflict resolution.
- [x] Additive storage with immutable ancestry/history, archive/restore rules and mandatory optimistic revisions.
- [x] Canonical shared-Project SQL/store admission: participants read, owners govern, workspace-owner oversight read-only; assistant admission, disabled/quarantined scopes and archived ancestry enforced.
- [x] Authenticated hierarchy/definition/history/effective REST APIs; no command execution or source fetching.
- [x] Executor-independent, non-dispatchable preview/result contracts with blocked-only automatic-verification helper.
- [x] Focused domain, route, store and restricted-role SQL tests supplied. Current validation results must be recorded separately from implementation status.

### Phase 2: management, independent review and impact (implemented foundation)

- [x] Shared-Project management UI with hierarchy, definition templates, history/origins/conflicts, authority leases, authored draft recovery and four locales.
- [x] Separately authenticated human-owner approval of exact current revision; authors/agents cannot self-assert approval.
- [x] Persisted human runs with build/environment identity, requester/session binding, per-criterion evidence, immutable results and audit history.
- [x] Manual human/QA checklists, honestly labeled `human_reported` rather than independent agent screenshots.
- [x] Source mappings and same-Project dependency contracts; consistent impact snapshots with bounded ancestor/reverse-dependency selection and reason paths.
- [ ] Integrate mapped repository identifiers with authorized source resolvers. Mappings fetch no code and grant no source/command authority.

### Phase 3: native context and existing sidanCode connector

- [x] Implement `context.ts`: authorized lineage, canonical scoped prompt, actual unit/integration test obligations, provenance, conflicts, bounded output and live authority/scope-floor handling.
- [x] Implement four read tools in `tools.ts`: `getProjectHarnessContext`, `listProjectHarnessScopes`, `selectProjectHarnessTests`, `getProjectHarnessAcceptance`.
- [x] Wire all five native read-only tools in boot; reuse canonical MCP projection with existing per-operation credential consent and live admission.
- [x] Add automatic native Project-bound prompt injection through shared run preparation (web/native MCP turns, channels, public-turn and A2A entrypoints carry the retained accumulator). Only one explicit write-default Project qualifies, and the context-read operation must be admitted. System/public/guest identities do not auto-inject; legacy Projects contribute nothing. Shared-Project denial/outage/oversize fails explicitly. Product/Component selection remains explicit through tools.
- [x] Implement/read-only-test `prepareProjectHarnessTask`: return exact `new_task_with_context` arguments, require explicit `brianTaskId` for a current readable Task in the selected Project and a separate `runtimeProject` profile key, retain canonical constraints and explicit selected scope. No launch, connector selection, approval, conversation-history copy or run/evidence writes.
- [x] Prepare implementation context and impact-selected coding/test plan from one authorized snapshot. Accept changed sources OR explicit scopes, default to coding scope, require coding-scope coverage, and include ancestor/reverse-dependent checks/scenarios with reasons and revision provenance. Blocked plans produce no handoff arguments.
- [x] Supply the actual Product name and nonempty `context.verification` to use Sidan's existing follow-up review mechanism. Bind the canonical plan by SHA-256; request actual checks, per-criterion evidence/status, honest blockers and re-selection for uncovered actual changes. This is coding review, not human approval, independent browser acceptance or Brian result ingestion.
- [x] Remove the bespoke Docker/browser runtime, fixture provisioner, dispatch route and reaper. Keep the PostgreSQL validation runner and trusted SQL/store agent-evidence contract.
- [x] Reject `POST /runs` with `executor: "agent"` as `503 harness_agent_runtime_unavailable` before persisting a run; human workflow remains available.
- [ ] Automatic external connector dispatch from a prepared harness task — **not implemented**. Existing generic connector tools may be used separately under ordinary authorization.
- [ ] Durable binding of an external task to selected Brian scope, revisions and impact plan — **not implemented**. Prepared context is a snapshot, not durable binding.
- [ ] Canonical context refresh/revalidation on resumed external tasks — **not implemented**. Sidan `send_message` resumes native history; do not assume its original context is current.
- [ ] Trusted MCP submission of reports/evidence and reconciled acceptance results — **not implemented**. Read tools do not expose SQL agent mutation commands; a turn completion or review report is not a harness result.

The existing external protocol is `new_task_with_context({brianTaskId, prompt, context, cwd?})`. Context fields are `summary`, `conversation`, `constraints`, `references`, `project`, `product` and `verification`; there is no Sidan Component field. `context.project` selects the runtime checkout/profile, not Brian admission. Authorized Brian scope/provenance belongs in the prepared context. References/verification are text, not auto-fetched sources or commands. The prepared handoff supplies verification to request Sidan's existing review mechanism with the same context and implementation output; that is not isolated browser acceptance. Directory-correct Pi review is provided separately by [sidanCode PR #5](https://github.com/awcjack/sidanCode/pull/5): it consumes `report_execution_target`, validates the original profile scope and expected Git repository, then starts fresh review in the reported worktree/nested directory. The original runtime otherwise retains the task's initial cwd. Promotion of that companion change and the pinned agentbox tool remains a deployment gate. Check `spawned_review_id` and the review task outcome; review startup/success is not guaranteed by implementation completion, and Sidan spawns at most one review per implementation task. The handoff wire format is unchanged; no new credential mechanism or approval-relay change is introduced. The companion Sidan directory-validation integration is a separate repository/PR, not bundled or deployed by this branch.

### Phase 4: validation and rollout gates

- [x] Supply guarded disposable PostgreSQL full replay/upgrade and real middleware/concurrency suites (`scripts/project-harness/verify-postgres.mjs`).
- [ ] Execute real fresh/upgrade replay under ordinary migration owner/restricted app roles, including lock-wait revocation/expiry and concurrent claims/completion.
- [x] Focused-test native prompt/preparation and canonical executor/MCP invocation: caller identity, live admission, Project scope floor, explicit child scope, fail-closed conflicts/size, no launch or mutations. Deployed connector validation remains separate.
- [ ] Exercise the existing connector against an explicitly authorized runtime project. Verify prepared argument fidelity and distinguish native turn/review outcomes from acceptance. This is not sandbox certification.
- [ ] Independent real-browser journeys: hierarchy/inheritance, Calendar-local isolation from Logo, stale revision/drafts, archive, independent approval, human checklists, participant/oversight/outsider access and revocation.
- [ ] Verify selected code checks against an authorized repository and independently execute selected acceptance journeys. Source mappings alone are insufficient.
- [ ] Design and independently validate any future automated acceptance trust boundary before enabling agent runs or exposing evidence submission. Do not revive the removed runtime implicitly or treat MCP connectivity as proof.

## Foundation API contract

All endpoints are under `/api/workspaces/:workspaceId/projects/:projectId/harness` and use authenticated actor identity, never actor IDs from request bodies.

- `GET /tree`: Product/Component metadata, ancestry and revisions.
- `POST /products`; `PATCH /products/:productId`: create/update/archive Products.
- `POST /products/:productId/components`; `PATCH /products/:productId/components/:componentId`: create/update/archive Components.
- `GET /definition?scope=project|product|component&productId=...&componentId=...`: current definition or null.
- `PUT /definition`: `{ scope, expectedRevision, definition }`; immutable history plus updated head.
- `GET /history` with the same scope query: revision history.
- `GET /effective` with the same scope query: effective rules/checks/scenarios, originating revisions and conflicts; not last-writer-wins.
- `POST /impact`: exactly `{ changedSources: [{repository,path}] }` or `{ scopes: [HarnessScope] }`; returns `{impact}` from the authorized snapshot. Structural readiness is not dispatch authority.
- `GET /approvals` and `GET /runs` with the same scope query.
- `POST /revisions/:revisionId/approve`: `{expectedRevision,reason}`; separate live human owner required.
- `POST /runs`: strict approval/scenario, executor, build/deployment, target/origins and environment facts; server creates the pinned preview for human runs. `executor: "agent"` returns 503, not a pending/blocked run or connector dispatch.
- `GET /runs/:runId`; `GET /runs/:runId/evidence`.
- `POST /runs/:runId/evidence`: `{criterionKey,text}` human-reported observations only.
- `POST /runs/:runId/result`: complete human result, checked against persisted criteria/evidence.
- `POST /runs/:runId/cancel`: strict empty object. There is **no `/dispatch` endpoint**.

Endpoints use `Cache-Control: no-store`. Approval/run mutations require current human JWT session identity; legacy tokens and delegated agent contexts cannot mutate acceptance execution. Trusted agent claim/evidence/completion methods remain owner-only SQL/store commands with no public REST or MCP mutation equivalents.

## Validation record and limitations

Post-correction validation (local, no live services):

- **332 API tests across 15 suites passed**: harness domain/context/tools/native preparation/MCP projection, snapshot-consistent impact/review handoff, shared run preparation, REST, stores and focused PGlite migrations.
- **85 existing regressions across six API suites passed**: workspace MCP catalog/consent/native transport and execution context/authority lease/turn-scope resolution.
- **56 web tests across four suites passed**: harness UI/API, authority leases and durable drafts.
- API and full app-web typechecks passed. PostgreSQL runner syntax, tracked/untracked whitespace and NUL checks passed.
- Existing Sidan synthetic verification-spawn/no-verification and context-protocol tests passed offline via `GOTOOLCHAIN=local GOPROXY=off go test ./internal/tasks ./internal/httpapi -run 'Test(VerificationSpawnsIndependentReviewSession|NoVerificationDoesNotSpawnReview|NewTaskWithContextAcceptsProjectProductVerification|ContextBundleProjectFieldsSatisfyNonempty)$' -count=1`. Those initial protocol checks made no Sidan source changes or real runtime/connector calls. The later companion [sidanCode PR #5](https://github.com/awcjack/sidanCode/pull/5) separately passed its full Go race tests, vet and build, including RPC fakes and disposable Git worktrees; it has not been live-activated.

These totals exclude removed runtime tests. No live connector call, full PostgreSQL replay or browser acceptance is included.

Focused test suites cover domain/inheritance/impact, preview/result contracts, context/read tools, authenticated routes, stores and new SQL migrations under PGlite, plus web management/run/cache/draft regressions. PGlite uses explicit prerequisites and does not establish full historical replay or real concurrent lock behavior. Source review and mocked protocol tests are not live acceptance.

The real PostgreSQL replay/upgrade/concurrency gate and independent browser acceptance have **not been executed**. No live workspace migration, application deployment, real connector task or credential operation is claimed. Reproduction commands are in the rollout checklist; the recorded focused results do not close those gates.
