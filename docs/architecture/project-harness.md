# Project engineering harnesses

Implementation status and remaining gates: [plan](../plans/project-harness.md). Deployment and acceptance procedure: [rollout](../plans/project-harness-rollout.md).

## Current scope

Shared Project → Product → Component hierarchy, versioned engineering definitions, inherited rules, management UI, independent human review, persisted human/QA runs, impact planning, and native read-only context tools are present. Coding work uses Brian's existing custom MCP connector to **sidanCode**, not a new harness execution service. The superseded custom Docker verifier, fixture provisioner and container reaper are removed; there is no harness runtime to configure.

Native registry wiring, consent-filtered MCP projection, Project-bound prompt injection and `prepareProjectHarnessTask` are implemented and focused-tested; see the [plan](../plans/project-harness.md) for the validation boundary. Automatic external connector dispatch, durable external task/selection binding, refresh on resumed external tasks, and MCP report/evidence submission are **not implemented**. Human approval and manual checklists remain the acceptance path. **No live PostgreSQL replay or independent real-browser acceptance has been performed.**

A Product is a managed engineering surface, such as Frontend or Backend. Components own bounded responsibilities, such as Calendar Picker or Availability API. These scopes organize instructions, not permissions. The existing Project Brief remains authoritative direction. Legacy Projects and new-workspace shared-Project defaults are unchanged.

## Storage and authorization

`8269_project_harnesses.sql` adds:

| Table | Responsibility |
| --- | --- |
| `project_harness_products` | Product metadata, archive state, optimistic revision |
| `project_harness_components` | Component metadata and immutable Product ancestry |
| `project_harness_revisions` | Append-only definition snapshots at each scope |

Composite foreign keys bind every child to its full workspace/Project/Product ancestry. The latest revision is the head; there is no independently mutable second body. History returns the newest 100 snapshots, retaining older revisions. There is no delete/move API. Restoration is an explicit status-only update; parents must be active before descendants can change.

The definition store uses the restricted app connection and `applyRLSGucs`. Lineage and impact snapshots use repeatable-read, read-only transactions. Writes lock workspace, shared scope, Project and relevant descendants, then recheck authority. Expected revisions are mandatory; zero creates the first definition, while node updates require positive revisions.

Canonical Department/shared-Project admission enforces the internal sensitivity floor, live human/assistant membership, credential restrictions, quarantine and capability disablement. Participants read; Project owners govern. Workspace-owner oversight is read-only. Archived ancestry permits historical reads but blocks writes. Hidden/missing targets return not-found; visible legacy Projects receive `harness_requires_shared_project`, not automatic conversion.

App-role direct DML/internal helper access is revoked. Definition history is immutable even for the database owner, except during workspace teardown. SQL independently checks definition shape. Text is ECMAScript-trimmed and bounded in UTF-16 units; a 128,000 aggregate string-value budget avoids JSON serializer spacing differences. NUL/unpaired surrogates are rejected at the application boundary.

### Approval, runs and evidence

`8270_project_harness_verification.sql` adds `project_harness_approvals`, `project_harness_runs`, `project_harness_evidence` and `project_harness_execution_audit`.

- Approval pins an exact current definition revision, reviewer identity, authenticated session, reason and timestamp. A live human Project owner **other than the revision author** must approve. Client flags and agent/delegated contexts cannot assert approval. Account distinction enforces separate principals, not absence of collusion.
- A live human participant creates a run from a stored approval/scenario. The server builds the preview and pins build/deployment/environment, requester/session, target, specification hashes and executor. Schema/storage retain `human` and `agent` records, but HTTP creation with `executor: "agent"` returns 503 before persisting a run. Request bodies cannot supply a preview, requester identity or runtime configuration.
- Only the original requester/session can submit human evidence/results or cancel. Project owners cannot operate another requester's run merely because they govern the Project.
- The retained trusted SQL agent claim is a pending→running compare-and-set, not an exposed dispatch tool. Actions recheck head, approval reviewer ownership/clearance, requester admission, active ancestry, cancellation, session validity and wall-clock expiry after authority locks. Final results are immutable; completed runs cannot be reopened. New attempts use new runs.
- Text observations are `human_reported`, not independent browser evidence. The retained trusted agent-evidence SQL/store contract accepts bounded PNG/base64 plus digest and `isolated_browser` provenance; no active harness runtime or MCP recorder exposes this path. That stored provenance label alone does not establish isolation. Passed criteria require stored same-run/same-criterion references. PNG validation bounds canonical bytes and checks signatures; it is not a full image decoder or semantic proof of behavior.
- Evidence and audit rows are append-only. Runs retain build, requester and timestamps even after account/session erasure. Workspace teardown cascades through execution history; ordinary history deletion remains prohibited.
- Runs expire after 30 minutes; list/get lazily marks abandoned live runs expired. Cancellation/expiry/stale approval cannot publish a result. If authority disappears, subsequent result publication is denied. There is no harness-owned runtime or cleanup service.

The execution store uses the **server owner pool** with explicit canonical checks on every entry point. Unlike definition commands, **all execution commands are owner-only and not granted to `app_user`**. Actor GUCs are context, never a trusted-system capability. Do not expose execution mutation callbacks as model tools. Read-only tools may use the authorized approval/run readers. RLS still protects ordinary direct reads. Real middleware/database and concurrent lock-wait tests are supplied but have not run here.

## Effective harness semantics

`resolve.ts` accepts an authorized lineage and preserves origin scope/revision for every item:

- Invariants inherit and cannot be changed/weakened; identical invariants are redundant.
- Defaults inherit; same-key specialization requires `override: true`.
- Local rules apply only at their exact scope, not descendants or siblings. They may explicitly specialize a default, never an invariant.
- A dangling override is a conflict. Foreign ancestry/duplicate heads are rejected; missing definitions are allowed.
- Code checks/scenarios are additive and origin-qualified. Reusing a key does not delete an inherited check.

`resolved` means structurally consistent, not approved, executable, semantically correct or well-covered. Different-key prose contradictions still require review. Calendar Picker's local width rule never enters Logo's effective definition.

## Ownership and impact planning

Definitions optionally contain:

```json
{
  "sourceMappings": [{ "repository": "frontend", "pathPrefix": "src/calendar" }],
  "dependencies": [{ "scope": { "kind": "product", "productId": "<uuid>" }, "contract": "Uses the availability API contract" }]
}
```

Paths are normalized relative file/directory prefixes, not executable globs. Dependency targets must exist and be active in the **same Project** when authored. Metadata is not permission to read a repository, execute a command or dispatch a test. No source contents are fetched. Integration with authorized repository/source resolvers remains a follow-up; existing source access boundaries must be reused.

`readHarnessProjectSnapshot` reads the complete authorized tree and current heads consistently. `selectHarnessImpact` maps changed source paths (or explicit scopes) to owners, ancestors and transitive reverse dependencies. It handles cycles with bounded deterministic traversal, reports reason paths, and deduplicates origin-qualified checks/scenarios. Selecting another scope's tests does **not** inherit its rules. Uncovered changes, archived/missing targets, unresolved dependencies and selected-lineage conflicts block structural readiness. Approval/run creation remain separate from test selection.

## Management UI

`apps/app-web/src/components/projects/project-harness.tsx` is mounted only on shared Project detail. Owners manage hierarchy, JSON definitions with rule/check/scenario templates, history, conflict origins and independent review. Participants can create runs and complete their own human checklists; oversight is read-only. All four locales are covered.

Shared viewer-scoped cache/authority leases govern protected reads. Authoritative read denial removes protected content; operation-specific mutation denials revalidate without treating every failed action as loss of read access. Identity changes abort deferred dialogs. Equivalent background renewals do not cancel editing dialogs.

Durable drafts store authored insertion spans/deletion offsets, not automatic protected server snapshots. Recovery retains the base revision. Only byte-identical bases can rebase by carrying the existing multi-span patch forward; changed bases require manual recovery of authored text. Concurrent revision failure cannot silently overwrite a newer definition. Durable user-authored text may itself contain sensitive material: normal local-device security still applies.

## Acceptance preview and executor boundary

`verification.ts` builds a cloned/frozen `non_dispatchable_acceptance_preview`. It includes one scenario and pinned identity/hash/build/environment/target fields, not code-check instructions, siblings, implementation history, source or credentials. The label deliberately remains non-dispatchable: a packet alone never establishes approval or a trusted claim.

Targets are canonical HTTPS without userinfo/query/fragment and exact permitted origins. Shape validation is not network enforcement or secret detection. Approved prose and URLs must be credential-free. Results require complete unique criteria and matching binding/evidence references, with precedence failed → blocked → inconclusive → passed. Hashes prove content binding, not independent execution or correctness.

`runAutomaticVerification` remains a blocked-only preview helper, not an executor. `POST /runs` with `executor: "agent"` returns `503 harness_agent_runtime_unavailable`; there is no `/dispatch` route. Trusted SQL/store agent claim, screenshot-evidence and completion commands remain for the persistence contract and tests, but are not exposed as native or MCP tools. A model-authored report cannot substitute for those trusted commands or independent approval.

## Native context and existing MCP connector

`context.ts` loads an actor-authorized lineage and renders a canonical engineering contract with scope/revision provenance, conflicts, effective rules/checks/scenarios, and exact-target source/dependency references. It rechecks the host-owned live authority before and after reads and records the internal Project scope floor. Oversized context fails closed rather than truncating invariants. Source mappings are references, not source access. The contract explicitly requires actual unit and integration tests for changed behavior and contract tests for affected dependency interfaces, reporting tests not run and blockers; prose and mocks alone do not fulfill that obligation. Read tools establish the canonical execution access with `runWithAgentAccess`, intersect any parent ceiling, and explicitly check the Project/compartment/internal floor before definer reads. Programmatic/delegated actors come from canonical execution identity, never billing attribution. Result limits cover the exact serialized token estimate as well as characters, preventing a successful oversized CJK result from being truncated by the universal tool-result cap.

`tools.ts` registers five native read-only tools, projected through Brian's existing canonical MCP catalog/executor and credential consent:

| Tool | Read-only responsibility |
| --- | --- |
| `getProjectHarnessContext` | Effective lineage and canonical implementation prompt; default active Project/project scope. |
| `prepareProjectHarnessTask` | Snapshot-consistent scoped contract and impact-selected coding/test plan rendered into sidanCode `new_task_with_context`, including `verification` for existing follow-up review; no connector dispatch. |
| `listProjectHarnessScopes` | Authorized hierarchy metadata for explicit scope selection, not sibling definition bodies. |
| `selectProjectHarnessTests` | Impact plan from an authorized consistent snapshot; no commands or source fetches. |
| `getProjectHarnessAcceptance` | Scenarios from a persisted approved revision, optionally run metadata; no implementation prompt, approval or evidence writes. Historical records do not establish current freshness. |

`turn-context.ts` injects Project-level context through the existing shared `prepareAssistantRun` stage, after the Brief. The canonical callback is captured before asynchronous assembly and checked with the existing pre-assembly authority guard; final authority is checked again before returning provider-ready context. The exact retained turn accumulator receives scope evidence. Only a workspace turn with one explicit write-default Project and admitted `getProjectHarnessContext` qualifies; system, guest/public and unattributed programmatic identities do not auto-inject. Legacy Projects contribute nothing; unavailable/oversized shared-Project contracts stop preparation, not silently become empty. No Product or Component is guessed from task prose. Product/Component scope requires explicit selection. The read-only `prepareProjectHarnessTask` prepares exact `new_task_with_context` arguments; it does not launch a task, create a run, approve a specification or dispatch a connector. Its `runtimeProject` is an explicit sidanCode runtime/profile project name, **not** Brian's Project UUID. Canonical obligations/constraints cannot be replaced by caller-authored constraints. Do not infer durable selection binding or external resume refresh from prompt injection or preparation.

### Impact-selected coding/review handoff

Preparation accepts `changedSources` **or** explicit impacted `scopes`; if neither is supplied, selection defaults to `[codingScope]`. Both modes cannot be supplied together. One authorized repeatable-read Project snapshot supplies the implementation lineage, Product name, dependency graph and selected checks/scenarios; separate lineage reads cannot mix old implementation rules with newer test heads. The explicit coding scope must itself be covered by the impact selection. Uncovered changes, missing/archived scopes/dependencies and selected-lineage conflicts return `status: "blocked"` and no `arguments`; missing/conflicted coding contracts fail explicitly. Oversized output fails instead of truncating tests or invariants.

The prepared wire bundle contains:

- `context.project`: explicit runtime/profile key.
- `context.product`: actual selected Product name (omitted for Project-only scope); not a scope identifier, guessed directory or permission.
- `context.constraints[0]`: canonical effective implementation contract for the selected coding lineage only.
- `context.constraints[1]`: canonical `impact_selected_coding_test_plan`, including selection inputs, selected heads, selected Product/Component names and ownership source-mapping references for locating cross-Product tests, origin-qualified code checks, acceptance preconditions/steps/criteria and ancestor/reverse-dependency reason paths. Selecting sibling/reverse-dependent tests never imports their implementation rules.
- `context.references`: revision references for both implementation and selected test scopes; no source contents or automatic dereferencing.
- `context.verification`: nonempty review instructions referencing the exact plan ID plus per-check/scenario identifiers and criterion keys. The full plan stays in constraints, which Sidan also gives the review session.

The SHA-256 `planId`, revision references and selection are returned in `binding`. This binds prepared content, not a durable external task, human approval, actual execution or fresh authorization at future launch. Caller-authored verification or test-plan blobs are rejected. Example preparation input:

```json
{
  "runtimeProject": "configured-checkout",
  "prompt": "Update the availability contract and its consumers",
  "scope": { "kind": "component", "productId": "<backend-product-uuid>", "componentId": "<availability-component-uuid>" },
  "changedSources": [{ "repository": "server", "path": "src/availability/schema.ts" }]
}
```

Only a `status: "prepared"` response contains `arguments` for the existing authorized connector call; inspect blocked planning results instead of starting a partial task. The review must inspect/re-run actual authorized checks, report commands and observations per item/criterion, mark unavailable environment/evidence blocked or inconclusive, and flag changes beyond the supplied selection for fresh impact planning. An empty authored test list does not waive actual unit/integration/contract testing. Authored acceptance scenarios here are review targets, **not claimed approved acceptance**; use the separate approval/read/run workflow for that.

The existing sidanCode contract is `new_task_with_context({ prompt, context, cwd? })`, where `context` supports `summary`, `conversation`, `constraints`, `references`, `project`, `product` and `verification`. `context.project` selects the configured runtime project/cwd/profile; `context.product` is descriptive product-name context, not a Brian ACL, scope selector or automatic subdirectory switch. There is no separate Sidan Component field: selected Brian scope and provenance belong in the prepared context. References are text, not automatically fetched. Send only authorized, relevant context; MCP does not expose hidden caller history. The wire format is unchanged. The companion [sidanCode PR #5](https://github.com/awcjack/sidanCode/pull/5) adds directory-correct Pi review using the pinned agentbox `report_execution_target` tool; it is delivered and promoted separately from this repository.

Actual external task start/monitor/continue uses the existing connector's tools and ordinary authorization. `get_task`/events report native turn outcomes, not harness acceptance. Wait for `active: false` before `send_message`; continuation resumes native history. Automatic canonical refresh for resumed external tasks is not implemented, so previously supplied context must not be assumed current. Durable binding between Brian scope/revisions/impact selection and an external task is a follow-up, as is trusted report/evidence ingestion.

### Execution, review and credentials are separate boundaries

An MCP connection proves neither a sandbox nor source-blind execution. sidanCode runs coding sessions in the selected checkout using its configured Codex or Pi runtime. Nonempty `context.verification` is reference text, not a command: after a successful implementation turn it can trigger one new review session with the same context, implementation prompt/output and working-tree/check access. The original runtime uses the task's initial cwd. With companion sidanCode PR #5, Pi instead requires a fresh correlated `report_execution_target`, validates existing paths and expected Git repository within the original authorized profile root, and starts review at that actual worktree/nested directory without resume or new mounts. Missing/invalid/stale targets block review rather than fall back. The optional operator-only `SIDAN_PI_REPOSITORIES` identifies an expected repository nested under an existing umbrella profile; it grants no source access. This does not provide directory discovery or runtime configuration inside Brian. The handoff now supplies this verification field. Check the implementation task's `spawned_review_id` and then the review task's state/output; neither a populated field nor implementation completion proves review startup or success. Sidan spawns at most one such review per implementation task, not one on every subsequent `send_message`. That review is not a history fork, but it is also **not independent browser acceptance**, a disposable application fixture, or a Brian approval/result record.

Credentials and approval relay are unchanged: task-control credentials stay in the existing connector configuration; the separate interaction credential is not an MCP tool credential. The trusted host-side relay, when configured, conveys exact eligible Pi dialogs to Brian's existing human approval flow; models cannot answer them through an approval MCP tool. Harness specification approval is a separate human decision. Completion workflow notifications report turn outcomes, not evidence of correctness or delivery. No secrets belong in harness definitions, prepared context, prompts or logs.

## Validation boundary

Focused domain/context/tool, REST/store, SQL, native preparation/MCP projection and UI tests pass locally; exact executed totals are recorded in the plan. Older test totals included the removed runtime and are not current coverage. PGlite executes the new migrations with explicit prerequisites under an ordinary migration owner/restricted app role; it is not full historical PostgreSQL replay or multi-connection proof. `scripts/project-harness/verify-postgres.mjs` retains the disposable fresh/upgrade runner and real middleware/concurrency suites. Those real PostgreSQL gates and the independent browser checklist remain unexecuted here. No live migration, real connector task, or browser acceptance is implied by unit tests.
