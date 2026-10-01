# Workspace access modes and Brian-assisted migration

> **Status 2026-10-02:** direction superseded by the platform plan `docs/plans/permission-model-v2.md` (§12 adopts this branch as its starting point); this note is kept unrewritten as the branch's history.

**Status: proposed implementation plan; no product behavior implemented by this document.**

## 1. Scope and working baseline

Implement both requested capabilities as one coordinated access project:

1. **Simple / Departments workspace modes:** a one-person company can use Brian without configuring departments; larger organizations can enable departmental boundaries.
2. **Brian-assisted legacy migration:** inspect, propose, review, apply and verify migration of people, assistants, existing data, connectors and unattended work. New frontend/API/ingest creations must obey the selected policy throughout migration and afterwards.

Worktrees prepared for this project:

| Repository | Worktree | Branch | Starting revision |
| --- | --- | --- | --- |
| use-brian | `/workspace/brian-access-modes/use-brian` | `feature/workspace-access-modes` | `origin/develop`, `c555316a132860799a6a8fb366a97049bf861ff8` |
| brian-kb | `/workspace/brian-access-modes/brian-kb` | `docs/workspace-access-modes` | `origin/develop`, `ea07cca` |

Both remotes were fetched before worktree creation. Existing worktrees are untouched. Changes in this preparation are documentation only; nothing is committed or pushed. Rebase on current develop before implementation, allocate migrations then, and do not reuse migration numbers from another in-flight branch.

This is an OSS product feature. Existing platform departmental-isolation plans remain relevant historical context, but runtime changes belong in use-brian. Keep the implementation plan in use-brian only. The brian-kb worktree is reserved for documentation derived from the actual design and implementation, not a separate plan or planning entries.

## 2. Product contract and non-goals

### 2.1 Simple mode

- Workspace Settings exposes **Access mode: Simple / Departments**, editable only by current owner/admin through reviewed commands.
- New workspaces default to Simple after deployment readiness is verified. Existing workspaces do not automatically change effective permissions on upgrade.
- One canonical, active default department represents shared workspace work. Reuse `workspace_groups` and the existing scope envelope, not a parallel content store or authorization implementation.
- Ordinary workspace members receive the default department's ordinary membership package; ordinary workspace assistants receive its audience/default context. New eligible members and workspace assistants receive the same defaults through canonical creation/join commands.
- Hide routine department pickers, managers and department-access request navigation. Show “Shared with workspace” on ordinary shared resources, plus any remaining private, Project or confidentiality restrictions.
- Personal chats, personal connectors, personal assistants and explicit private resources remain personal. External guests, public links, API principals and channel audiences are not made workspace members.
- “Everything shared” means department-level sharing of ordinary workspace resources, **not** public access, administrative rights, credential disclosure, higher clearance, editing via read-only grants, removal of Project restrictions, or permission to send data outside the workspace.
- Preserve normal action confirmations, tool Allow/Ask/Block settings and connector ownership. A sole owner needs no independent approver to choose workspace mode; independent approval remains required for the existing cross-department request mechanism, which Simple does not need.
- No hidden `read_all` package that grants access to future departments. The common department has only its own normal package.

### 2.2 Departments mode

- Expose current department membership, access packages, assistant audience/defaults, resource selectors, managers, requests and read grants.
- Reporting lines remain directory metadata, never authorization.
- Enabling the UI does not automatically classify historical resources or convert members from legacy access.
- Owner/admin broad authority remains as in the current product and must be explained in previews. This project does not introduce admin-excluding confidential departments.

### 2.3 Explicitly independent concepts

| Concept | Values / meaning | This project's rule |
| --- | --- | --- |
| Workspace experience/policy | New `simple` / `departments` | Determines admission defaults and available management workflows. |
| Classification lifecycle | Existing `legacy` / `review` / `strict` | Keep independent; no strict downgrade just because Simple is selected. |
| Human access mode | Existing `legacy` / `assigned` | Migration is explicit and reviewed, not a side effect of membership changes. |
| Assistant audience/default context | Existing all/assigned grants and defaults | Review separately; a user's migration does not rewrite assistant audiences. |
| Resource envelope | Visibility, sensitivity, department requirements, Projects, holding, source evidence | Preserved unless a specific authorized operation explicitly changes an axis. |
| Connector boundary | Ownership, Brian exposure, provider-native reach, permitted operations | A department label alone does not prove provider isolation. |

Non-goals: redesign the organization chart; change clearance semantics; auto-promote everyone to administrator; rewrite immutable audit history; enable arbitrary cross-department provider browsing; silently declassify held or private data; send invitation or migration notification emails without the normal delivery controls.

## 3. Verified current foundations and gaps

| Area | Current source | Implication |
| --- | --- | --- |
| Canonical management commands | `packages/api/src/workspace-access/{commands,service,command-review,tools}.ts`; `packages/shared/src/workspace-access.ts` | UI and Brian already share reviewed, versioned commands. Extend these rather than issuing raw SQL from tools. |
| Brian tools | `inspectWorkspaceAccess`, `manageWorkspaceAccess`, `requestWorkspaceAccess`, `inspectScopeReview`, `manageScopeReview` in `workspace-access/tools.ts`; registered in `packages/api/src/boot.ts` | Attended verified-human authority, nonpersistent confirmation and idempotency already exist. Add orchestration, not ambient admin authority. |
| Source inventory | `workspace-access/{scope-review,scope-review-registry}.ts` | Registry covers content, impacts, bindings and jobs. Actions vary per family. It is not an unrestricted bulk relabeler. |
| Native inventory gap | `inspectScopeReview` input enum currently exposes eight initial source kinds | Align tool/API/UI capabilities with the canonical registry using authorized projections; don't claim Brian can currently remediate every inventoried family. |
| Source review limits | `workspace-access/tools.ts`, `scope-review.ts` | At most 100 selected IDs, 500 known derived memories, 25 applies/page. Old previews and held/immutable resources have restrictions. Reuse these boundaries initially. |
| Readiness | `context-scope/context-readiness.ts`, `workspace-access/readiness.ts`, `packages/shared/src/department-isolation-coverage.ts` | Current code declares enforcement version 2. Live schema/coverage/inventory checks still matter; no deployment readiness has been measured in this planning task. |
| Human resolution | `packages/api/src/db/context-scope-store.ts`; operation predicates in migrations | Assigned access is bounded by membership packages and existing direct ceilings; read-only grants do not grant mutation. Model simulation must match SQL/runtime. |
| Context selection | `context-scope/resolve-turn-scope.ts` | Bound session/key context takes precedence. Existing explicit-null sessions do not acquire a newly changed assistant default. |
| Connector setup | `apps/app-web/src/components/context/connector-context-binding.tsx`; connector instance/grant stores; `apps/app-web/src/lib/connector-oauth-state.ts` | Inspected UI edits scope after creation. Omitted instance/grant arrays default to empty. Shared OAuth state does not currently carry department/project setup. Audit all provider-specific paths before implementation. |
| Connector safety | `context-scope/connector-exposure.ts` | Empty connector arrays mean company-wide/unbounded, not General. Finite turns cannot use them; generic catalogs require universe authority on relevant axes, even for department-labelled connectors. |
| Existing creation context | Chat surface, `routes/files.ts`, `routes/workflows.ts`, migration `599_saved_view_operation_scope.sql` | Chats/uploads, workflow authoring and linked Teamspace pages already have context handling; preserve and complete it, not replace it with a global user-department guess. |
| Docs drift | brian-kb `features/workspace-access.md` and `context-engine/scoped-context.md` contain older phase descriptions alongside newer sections | Reconcile against release code/evidence when publishing documentation. Do not copy old “version 1 / incomplete” statements as current facts. |

## 4. Architecture and data model

Names in this section are proposed, not existing schema/API promises.

### 4.1 Workspace policy metadata

Extend `workspace_access_policies` with:

- `access_mode` (`simple` or `departments`).
- `default_department_id`, workspace-local FK to one active Team/group.
- An explicit setup/compatibility marker if needed to distinguish unchanged legacy workspaces from completed mode setup; do not overload `classification_mode`.
- Reuse the canonical policy revision and events; add a separate configuration generation only if profiling/locking design requires it.

Constraints and lifecycle:

1. Simple requires exactly one canonical default shared department; reject archiving/removing it while active. Enforce locality in the database.
2. Backfill existing workspaces to Departments-compatible behavior without changing members, labels, grants, assistants or classification lifecycle. A single-member workspace is not evidence that all of its data is safe to share.
3. New Simple provisioning creates policy, default department, eligible member/assistant bindings and explicit provenance atomically. Fresh classification may become strict only through the actual readiness/inventory contract; never force it by a SQL default.
4. Do not change the meaning of existing `null`, `[]`, `all` or unknown department labels globally.
5. Missing mode/default metadata fails closed for new mode-dependent operations, with a repair path. It must not mean “share all”.
6. Invitation acceptance, member rejoin, assistant creation/transfer, workspace clone/import and workspace provisioning all use this policy. Workspace removal immediately ends the default membership's authority.

### 4.2 Canonical creation admission

Introduce a shared API-side admission/resolution service, provisionally `workspace-access/resource-admission.ts`, with shared request/result types. Use resource adapters rather than forcing every table into one physical schema.

Inputs: authenticated principal, workspace, operation/resource family, existing parent/session/binding, explicit requested envelope, observed policy revision and source evidence where applicable. Clients cannot supply trusted identity or effective grants.

Resolution precedence:

1. Enforce existing canonical parent/source requirements and any private/Project/sensitivity floor.
2. Apply an explicit authorized destination only if compatible with that floor.
3. For an otherwise unbound ordinary workspace creation in Simple, assign the canonical default department.
4. In Departments, suggest the active destination or assistant default only where that resource's existing contract allows it. Multiple memberships or no valid parent require a choice, not union-of-everything.
5. A missing/ambiguous classification is `needs_selection` or protected holding; it is not silently General. Explicitly reviewed General remains legal under the existing policy.

Return effective labels, origin (`explicit`, `inherited`, `workspace_default` mapped safely into existing provenance), visible access explanation, revision and any blocker. Distinguish omitted selection from explicit General/null; reject stale legacy-client requests when applying a default would change their intent.

Persist the admitted envelope and resource in the same transaction. For external provisioning, activate the local exposure/ingest only after final admission succeeds. Recheck after asynchronous work rather than trusting an expired initial form preview.

The backend remains authoritative for browser, desktop, native Brian tools, public/API intake, webhooks, imports, background workers and integrations. Frontend hiding is not enforcement.

### 4.3 Durable migration records

Add RLS-protected workspace-local migration plan/item storage, referencing existing saved command and scope-review IDs rather than duplicating their mutation implementations.

Plan fields: source/target mode, actor, status, manifest/schema/policy/inventory revisions, intended population, generation, proposal hash, expiry, timestamps and summary counts. Item fields: typed subject/resource reference, exact proposed action and reason, before/after envelope or authority diff, evidence/dependency versions, review reference, idempotency key, status and content-free diagnostic.

Suggested states:

`draft -> inspected -> proposed -> awaiting_confirmation -> applying -> verifying -> completed`

Additional states: `blocked`, `stale`, `paused`, `cancelled`. Only one active mode-transition plan per workspace. Data-review batches may be children of that plan. Locks and constraints prevent duplicate workers and contradictory transitions.

No API accepts an arbitrary SQL action, user-selected actor, readiness boolean or unvalidated model-generated grant set. Stored proposals are not authorization; every apply rechecks current authority.

## 5. Mode transition semantics

### 5.1 New workspace -> Simple

Provision one shared department and explicit defaults. Retain ownership, clearance and private boundaries. Gate default rollout on deployed intake/connector coverage and tests. If the release is not ready, do not advertise a working Simple mode with an unsafe legacy fallback.

### 5.2 Existing legacy workspace -> either mode

Offer a nonblocking admin banner: “Review workspace access with Brian”. Inventory first. Selecting Simple is not a shortcut around legacy-data review. Selecting Departments keeps legacy users clearly labelled until their access migration is approved.

### 5.3 Simple -> Departments

- Default department becomes a visible ordinary shared department; do not automatically move its data or remove membership.
- Enable departmental configuration through one reviewed policy command.
- Create additional departments without wildcard memberships or inherited `read_all` access.
- Brian proposes narrowing/reclassification and member/assistant changes in explicit batches.
- Previously shared information cannot be made unseen. Warn before an admin treats old shared material as newly confidential.
- Invalidate Simple-only provider exposure authorizations and require a fresh connector/workflow review before restricted-context use. Reevaluate active turns and jobs at the boundary.

### 5.4 Departments -> Simple

This is a potentially broadening migration, not a cosmetic toggle:

1. Inspect all active departments, membership/direct caps, assistant audiences, source labels, grants, connectors, workflow authority and historical references.
2. Preview each loss of department restriction, each gained read/edit path, and the effect on future members. Never treat read-only collaboration grants as ordinary edit membership.
3. Reclassify only mutable eligible workspace content through a new reviewed broadening operation where necessary. Existing `assign_team` only adds a Team to unheld General data; it cannot implement this transition.
4. That new operation needs full before/after evidence, explicit affected audiences, source-version updates, descendant invalidation/holding, current-policy checks and audit. It cannot clear private, Project or confidentiality restrictions or release held data.
5. Immutable receipts/audit and historical departments retain their original identities. Unknown lineage, unsupported families and held history must be resolved, regenerated through a supported path, or deliberately retained in protected holding. Never overwrite history to satisfy the UI.
6. Final eligibility requires that ordinary active workspace work no longer depends on non-default departments, all access changes are accounted for, and no unsupported active connector/job remains. Retained restricted history stays accessible only through an authorized recovery/history screen, not routine Simple sharing.
7. After validated consolidation, archive unused departments only when safe; keep historical links. Preserve meaningful grant history and explicitly settle/revoke active department requests/grants that are superseded.

**Cancellation semantics:** before any apply, cancellation changes nothing. Once an approved batch applies, its permissions/data changes are real immediately, even while the workspace still displays the old mode. Cancellation stops further batches; it does not undo previous changes. Display this before approval and on progress screens. Final mode activation is an atomic policy change, not a promise that every earlier batch was invisible.

### 5.5 Concurrency and finalization

- All relevant policy changes/admissions follow one documented lock order; coordinate through the workspace policy row and revision or an equivalent proven serializable protocol.
- Lock/recheck current actor, policy, defaults, selected resources and dependent evidence in canonical order. Do not hold database locks while waiting for an LLM, human confirmation or OAuth provider.
- An inventory snapshot is not final if new unreviewed bindings/resources arrive. Reconcile concurrent writes, create an incremental tail review, and refuse final activation until the latest inventory revision qualifies.
- Freeze the final admission-policy switch in one short transaction. Late OAuth callbacks, scheduled jobs and old browser clients must re-resolve against the resulting policy.
- Existing pinned turns/runs do not gain expanded rights. Contractions invalidate authority leases and protected projections; affected work stops/rebuilds with a clear reason.
- Recovery is a fresh compensating proposal under current policy. No restore-all button and no automatic release of holds.

## 6. Brian-guided legacy migration experience

### 6.1 Entry points and flow

Settings > Workspace > Access mode, Organization > Access, and a verified admin conversation can start the same durable plan. A small workspace can say: “Make this a simple shared workspace.” An organization can say: “Help move legacy users into departments.”

1. **Inspect:** use current registry/access tools, inventory adapters and readiness. Report legacy people, unsupported families, direct ceilings, read-all packages, grant paths, assistant audiences, connector reach and unattended work. Scope explanations to the actual executing conversation; never substitute assistant owner/billing owner for the human.
2. **Ask:** confirm departments, person assignments, shared material, ambiguous data and connector ownership. Treat names, document text, reporting lines and usage history as suggestions, not permission.
3. **Propose:** persist bounded explicit actions with reasons, target IDs and source evidence. No content from another workspace or hidden principal enters the proposal. Offer “leave unresolved” instead of guessing.
4. **Simulate:** compute old/new human read and edit reach, assistant reach, direct-ceiling intersections, independent grants and resource-specific constraints. Report concrete affected bindings/jobs and unknowns; don't claim a scope match guarantees operation success.
5. **Confirm:** show names, gains/losses, future-member consequences, exact action list/hash, policy revision and expiry. Use existing nonpersistent saved-review confirmation. Stale approvals require reinspection and a new preview.
6. **Pilot:** migrate a small named cohort after its data/connector prerequisites are prepared. Preserve member role and clearance unless separately approved. Set member `assigned` explicitly; review assistants separately.
7. **Apply/resume:** execute existing bounded commands, checkpoint every page and expose actual per-item outcomes. Idempotent retries return progress, not another page of writes. Do not auto-retry an external side effect whose outcome is uncertain.
8. **Verify:** test expected access and expected denials via server-side authorized simulation and controlled fixtures. Warn about broken workflows and connector restrictions instead of expanding access automatically.
9. **Complete:** record unresolved/held exclusions and test evidence. Strict classification, when required, is a separate final command bound to live policy and reviewed inventory revisions. Mode and migration completion are separate facts.

### 6.2 New orchestration surface

Proposed service/API/tool capabilities (names to finalize alongside schemas):

- Inspect mode/setup/migration status and readiness.
- Create or revise a draft plan; bounded paginated inventory.
- Simulate a proposed plan without writes or impersonated content access.
- Prepare an expiring confirmation for a concrete next batch or final mode change.
- Apply that saved review; pause/cancel; resume from durable progress.

Prefer extending the existing access command plane and adding a small migration facade over duplicating management tools. Native Brian and UI must receive equivalent previews/results. No arbitrary “run all future changes” approval, unattended administrator agent, or tools that choose the actor.

The current native eight-kind inventory enum must be reconciled with supported registry kinds and per-family actions. Binding/job remediation needs explicit adapters, not an undocumented bulk JSON patch. Restrict previews and logs; never put connector secrets or entire document bodies into migration telemetry.

## 7. New resource and frontend coverage

Create a checked-in admission manifest before editing writers: family, frontend entry points, API/native/background writers, canonical parent, default behavior in each mode, inheritance/invalidation, denial cases and test owner. Unknown writers are release blockers.

| Family | Simple behavior | Departments behavior / inherited floor | Required coverage |
| --- | --- | --- | --- |
| Members/invitations | Eligible new members join default shared department atomically | Explicit intended membership or pending setup; no silent legacy conversion | Accept/reaccept, bulk invite, external identity linking, role change, removal |
| Workspace assistants | Default shared audience/context, within clearance and tool settings | Explicit audience/default department; distinguish personal and app assistants | Creation, clone, transfer, delegate, public link, app-kind assistants |
| Chat sessions | Shared work defaults to common department; personal visibility stays private | Existing bound context wins; choose context for new unbound work | Web/desktop, shared rooms, channels, API keys, historical explicit-null sessions |
| Uploads/files/recordings | Inherit session/page or admitted default | Preserve source/parent floors; reject inconsistent session context | Upload start/finalize, chunking, recording transcription, byte/preview/export routes |
| Docs/Views/Office | New shared destinations use linked default Teamspace; private pages stay private | Linked Teamspace/parent envelope, Project and sensitivity remain authoritative | Create/import/copy/move, templates/assets, live collab, offline resync and publication |
| Tasks/CRM/knowledge | Shared defaults for truly unbound creations | Explicit or canonical source context; do not union every department the user can read | Forms, bulk imports, external-app interfaces, notes, corrections, API keys |
| Derived memories/summaries/skills | Carry source requirements, visibility and evidence | Never become broader because destination or user mode changed | Ingest, extraction, consolidation, retrieval indexes, embeddings, replay |
| Connectors/grants | Reviewed workspace-wide exposure where actually authorized; common department for admitted imports | Explicit department/Project exposure plus enforceable provider boundary | OAuth, manual/API key, CLI/MCP, share/grant, transfer, reconnect, discovery |
| Workflows/goals/schedules | Persist authoring defaults/authority and approved delivery | Bound authoring/execution ceiling; explicit resources and destinations | Create/clone/edit/enable, scheduled run, resume, delivery, publication consent |
| Webhooks/ingest/batches | Explicit configured source binding before ingestion | Current source binding and destination envelope; ambiguity held | Queued work arriving during transition, retries, reconnect, dead-letter recovery |
| API keys/public links/guests | Never inherit workspace-wide rights merely from Simple | Existing principal, audience and context constraints | Creation, rotation, existing keys, scope downgrades, anonymous entry points |

Frontend requirements:

- Shared mode-aware context picker/summary, not separate special cases in each form.
- Simple: default selection is automatic; no department prompt for ordinary work. Preserve clear private/Project/confidential labels.
- Departments: preselect only an authorized, unambiguous destination. If ambiguous, ask before activation/save; optional protected drafts must remain undiscoverable to unauthorized users and excluded from ingestion.
- Show effective destination before save; never flash a connected/shared success before scope admission completes.
- Handle policy-change errors by refreshing and preserving nonsensitive form input without automatically resubmitting a changed intent.
- Keep permission screens and review history reachable for admins in Simple, including held historical items. Non-admins see a mode explanation, not a toggle.
- Respect protected-projection lifetimes, viewer/workspace keys, cross-tab notifications, navigation deep links and server-time expiry. Invalidate even unmounted surfaces.
- Web and Electron use the same controls; include mobile layout, keyboard/screen-reader behavior and `en`, `ja`, `zh-cn`, `zh` copy. Read `apps/app-web/AGENTS.md` before implementation there.

## 8. Connector-specific design and release blocker

### 8.1 Atomic setup protocol

Add a server-owned pending connector setup containing workspace, actor/ownership, intended department/Project exposure, sensitivity/import destination, binding intent, provider boundary, policy revision, expiry and nonce. Store no raw credentials in review/audit payloads.

1. Start setup from the UI/API under current authority. In Simple, prefill authorized shared defaults without a department question, but still explain what account/source is being shared.
2. OAuth state carries an opaque signed/validated setup reference, not trusted client-supplied permission fields. Bind it to the initiating actor/workspace/provider; resist CSRF, replay and cross-workspace substitution.
3. Callback stores credentials privately/pending if needed, revalidates actor and policy, and only then atomically activates instance/grant/context/ingest admission. Failure leaves an explicit non-discoverable pending/error state with cleanup and resume.
4. Manual/API-key/CLI/MCP/native setup, workspace sharing and transfer use the same finalization. A connected credential is not by itself an active shared exposure.
5. Reconnect preserves existing ownership/scope. A changed mode or department requires fresh review; it must never reset arrays to unbounded. Multiple tabs/callback retries remain idempotent.
6. Cancellation/expiry cleans up pending local material safely. Do not revoke a pre-existing shared provider credential while cleaning up a failed reconnect.

### 8.2 Resolve the single-department vs provider-catalog mismatch

Current generic provider catalogs require company-wide authority. Giving a person the one default department is still a **finite** scope and will not make those catalogs work. Do not ship Simple with broken connectors or fix this by turning finite scope into universe everywhere.

Required design spike and explicit security review:

- Model a narrowly defined, server-derived **approved workspace-wide provider exposure** separately from department membership. It is bound to a particular active connector/grant, workspace, actor eligibility, operation policy, provider boundary and current access-policy generation.
- It does not change content RLS or let Brian read private rows/credentials. It is not valid for public/guest/programmatic callers by default, delegated narrower ceilings, a department-restricted turn, or a Project-restricted turn whose provider cannot enforce that Project boundary.
- The admin/credential owner must explicitly approve the actual provider account/root being shared; “Simple” is not evidence that an entire personal mailbox or drive is shareable. If a provider cannot constrain mixed personal/company data, require a dedicated account/root, keep it personal, or leave that operation unavailable.
- Switching to Departments or losing membership/connector rights invalidates the exposure; old runs do not inherit it. Ordinary tool/action approvals and external delivery checks still apply.
- Finite Departments contexts continue to use only audited fixed operations or proven provider-native roots. Metadata labels are not evidence of provider isolation.

The exact representation and proof belong in milestone M0. If this cannot be proven safely, preserve current denials and document the limitation; do not mark full Simple connector support complete. Do not choose a permissive fallback for product convenience.

## 9. Implementation packages and dependency order

Each milestone should be independently reviewable; paths below mix existing files to extend and explicitly proposed new modules.

### M0 — Freeze contracts, inventory and acceptance cases

- Build the creation/writer manifest and migration-family/action matrix.
- Specify Simple sharing semantics, role/assistant/guest behavior, connector exposure design, old-client handling and cancellation semantics.
- Capture fixtures: empty one-owner workspace, multi-user legacy workspace, explicit Departments workspace, private/Project data, mixed provider accounts, active grants and scheduled work.
- Review SQL/runtime set-algebra parity and source/descendant lifecycle before choosing migration operations.
- Deliver design sign-off and stable acceptance IDs. No permission changes yet.

### M1 — Schema, default department and policy resolver

- Add additive policy/default/migration tables, locality constraints, RLS, indexes and append-only audit integration.
- Extend shared types, commands, service and saved-review contracts.
- Add atomic new-workspace/member/assistant provisioning and admission resolver.
- Backfill compatibility metadata only; prove upgrade changes no existing effective permissions.
- Feature-enable only after mixed-version deployment handling is defined. Old workers must not create unscoped resources after activation; minimum-version admission checks may be needed.

### M2 — Close intake and connector creation paths

- Wire the manifest's writers into admission and preserve canonical inheritance.
- Implement pending connector setup and OAuth/manual/grant/reconnect finalization.
- Implement and test the approved provider-boundary design from M0 without weakening Departments.
- Include background jobs, direct API clients and clones/imports, not only frontend forms.
- Exit: no new ambiguous shared data or briefly unbounded connector exposure.

### M3 — Read-only migration inventory and simulation

- Add durable plan drafts, content-bounded authorized inventory, action capability discovery and before/after simulation.
- Reuse access inspection and registry; bring native tools into parity.
- Include affected jobs, connectors, sessions, keys, Teamspaces, caches and derived lineage.
- Show unsupported actions as blockers, not “migrated”.
- Exit: deterministic previews with no permission changes and SQL/runtime parity tests.

### M4 — Reviewed apply, mode transitions and recovery

- Connect plans to existing member/assistant/department/source review commands.
- Add separately audited broadening/consolidation operations needed for Departments -> Simple. Do not retrofit `assign_team` into unrestricted relabeling.
- Add lock ordering, idempotency, progress, stale detection, pause/cancel and compensating review.
- Enforce complete final inventory/admission barrier and live authority invalidation.
- Exit: crash/retry and concurrent-writer tests prove no unreviewed broadening or false completion.

### M5 — Brian playbook and mode-aware UI

- Add attended migration orchestration tools/instructions and review cards on the shared command plane.
- Add Settings mode selector, progress/resume, impact table, pilot cohort and recovery UI.
- Apply mode-aware creation controls and Organization navigation; preserve private/admin surfaces.
- Add localized user explanations for connector limitations, stale approvals and irreversible disclosure.
- Exit: one-owner setup requires no department knowledge, and admin-guided migration works end to end.

### M6 — Certification, staged rollout and KB publication

- Extend departmental-isolation manifest/suites, run disposable DB and browser evidence, and attach immutable reports to the release.
- Roll out read-only previews first, then new-workspace Simple, then opt-in legacy pilots; broadening transitions last after full adapter coverage.
- Monitor content-free failure/hold/denial and migration progress metrics. Feature disablement stops new transitions; it never rewrites existing policy or relaxes authorization.
- Publish corresponding KB behavior only when its implementation and tests have shipped. Keep blockers and pending milestones explicitly marked.

Dependency graph: `M0 -> M1 -> M2`; `M1 -> M3`; `M2 + M3 -> M4`; UI scaffolding may follow M1/M3, but final `M5` requires M2/M4; `M6` requires all. Database/shared-contract work precedes parallel API/UI implementation to avoid conflicting schemas.

## 10. Main code touchpoints

| Concern | Existing paths / proposed additions |
| --- | --- |
| Policy model | `packages/shared/src/workspace-access.ts`, `packages/api/migrations/`, `packages/api/src/workspace-access/{commands,policy,service,command-review,readiness}.ts` |
| Canonical scope/SQL parity | `packages/api/src/db/context-scope-store.ts`, `packages/api/src/context-scope/{resolve-turn-scope,execution-context,authority-lease,connector-exposure,workflow-authority}.ts`, `packages/core/src/security/` |
| Migration | `packages/api/src/workspace-access/{access-inspection,scope-review,scope-review-registry,tools}.ts`; proposed `migration-service.ts`, `migration-simulation.ts`, `resource-admission.ts` and store/schema |
| Routes | `packages/api/src/routes/{workspace-access,context-scopes,connectors,files,workflows}.ts` plus actual provider/provisioning writers discovered by M0 |
| Connector storage | `packages/api/src/db/connector-instance-store.ts`, `connector-grant-store.ts`, provider auth handlers and proposed pending setup store |
| Frontend | `apps/app-web/src/components/{workspace-access,organization,context,settings-modal}/`, `src/lib/api/workspace-access.ts`, `src/lib/connector-oauth-state.ts`, `src/lib/organization-navigation.ts`, `src/lib/i18n/dictionaries/` |
| Tests/evidence | `packages/shared/src/department-isolation-coverage.ts`, `scripts/test-department-isolation.mjs`, existing workspace-access/context-scope/connector/route/UI suites plus new mode/migration suites |

Do not assume this table is a complete writer inventory. Freeze actual adapters in M0 and expand the acceptance manifest whenever a new path is found.

## 11. Acceptance matrix

Every row needs positive and negative assertions, with application-role database tests where authorization is involved. “UI hidden” is never sufficient evidence.

| ID | Acceptance |
| --- | --- |
| AM01 | A fresh one-owner workspace creates ordinary shared work without a department prompt; required metadata/defaults are atomic and workspace-local. |
| AM02 | Existing workspace upgrade preserves permissions, labels, grants, workflow authority and legacy modes; no auto-flattening based on member count. |
| AM03 | Simple hides department complexity but private resources, Projects, sensitivity, read/write distinction, secrets and admin-only actions remain enforced. |
| AM04 | New eligible members/assistants inherit only the common department; external guests/public links/API keys do not acquire it. Revoked members lose it immediately. |
| AM05 | Simple -> Departments preserves existing content and creates no all-current/future-departments grant. New restricted departments remain isolated. |
| AM06 | Departments -> Simple previews concrete audience broadening and cannot complete with unsupported active classifications, mixed-source leakage or unresolved jobs. |
| AM07 | Brian cannot execute migration without the verified current admin or act through an owner fallback; approvals are concrete, expiring and nonpersistent. |
| AM08 | Before/after read/edit simulation matches canonical SQL/runtime across direct caps, packages, independent grants, assistant ceilings and Project/private checks. |
| AM09 | Stale policy, archived department, changed/deleted source, altered lineage and expired grant invalidate relevant proposals. No silent auto-reapproval. |
| AM10 | Restart, duplicated callback, repeated apply, lost response and concurrent admins do not duplicate changes or advance an unapproved page. |
| AM11 | Cancellation before apply is no-op; cancellation after apply preserves and reports prior changes. Recovery cannot resurrect expired/revoked authority. |
| AM12 | OAuth/manual/CLI/MCP setup has no usable unscoped exposure window; failed setup is private/pending, callbacks are actor/workspace bound, reconnect preserves scope. |
| AM13 | Generic provider catalogs remain denied to unsupported finite/Project contexts; approved Simple exposure cannot reveal a personal provider account or survive transition/revocation incorrectly. |
| AM14 | Every creation-manifest writer persists correct scope atomically. Omitted, explicit-null, forged, foreign, held and stale-client inputs have tested behavior. |
| AM15 | New writes during migration and late callbacks cannot evade final inventory. Old background workers cannot weaken an activated mode. |
| AM16 | Existing sessions, uploads, Teamspaces, workflow authoring/runs, goals, keys and queued ingest are individually reconciled; changing a default alone does not count as migration. |
| AM17 | Source changes hold/invalidate derived memories, caches and outputs as required; immutable history stays immutable; held content is not released by mode switching. |
| AM18 | Live chat/SSE/collab/byte delivery, queued runs, delegation and external delivery recheck authority; old contexts do not gain rights from expansion. |
| AM19 | Browser/Electron UI handles expiry, refresh, offline recovery, deep links and cross-tab changes without showing stale protected data; all supported locales covered. |
| AM20 | Strict activation uses real readiness, current manifest and completed inventory; neither mode choice, feature flag, empty result nor constant bump substitutes for proof. |
| AM21 | Logs/metrics/audit do not contain secrets or unnecessary content; plan/history permissions and pagination do not expose hidden users/resources. |
| AM22 | A sole owner can configure Simple safely without an impossible self-approval loop; departmental read requests still enforce independent approval. |

### Verification commands for implementation

Run from the code worktree after installing the pinned workspace dependencies. Confirm exact filters as scripts evolve:

```bash
pnpm install --frozen-lockfile
pnpm --filter @use-brian/shared typecheck
pnpm --filter @use-brian/api typecheck
pnpm --filter @use-brian/core typecheck
pnpm --filter app-web typecheck
pnpm --filter app-web typecheck:desktop
pnpm --filter @use-brian/api test -- src/workspace-access src/context-scope
pnpm --filter app-web test -- src/components/workspace-access src/components/context src/components/organization
node --experimental-strip-types scripts/test-department-isolation.mjs \
  --report /tmp/workspace-access-modes-isolation-report.json
```

Use the script's disposable local PostgreSQL fixture and configure `--pg-bin` if required. Never aim migration/security tests at a live customer database. Run additional writer/provider suites from the M0 manifest, script tests, package lint and browser/Electron scenarios; the short command list is not the full acceptance proof. Persist source revision, migration ledger, manifest, exact assertions and report hashes. Planning preparation does not claim any of these runtime tests passed.

## 12. Documentation follows design and implementation

Update brian-kb from the actual design decisions and implemented behavior as the work progresses. There is no separate KB plan, speculative feature entry or planning link to publish. Keep the KB worktree ready for those documentation changes.

Document verified behavior and limitations, reconcile superseded descriptions, and keep source references accurate. Do not describe proposed behavior as shipped; code and KB remain independently versioned repositories.

## 13. Open decisions and release gates

These require explicit resolution during M0, not silent implementation assumptions:

1. Approve the exact workspace-wide provider exposure representation and account/root-consent UX. Unsafe or unproven designs block full Simple connector support.
2. Confirm whether any supported workspace role besides current member should be eligible for default membership; preserve narrower roles if introduced later.
3. Define the exact adapters required to consolidate existing department-scoped content and the supported protected-history exclusions. Until complete, show Departments -> Simple as blocked with actionable reasons, not partially successful.
4. Agree on minimum compatible API/worker versions and deployment order; newer admission cannot rely on an old writer setting trusted fields.
5. Confirm operational batch sizes, query budgets and resumable scan strategy for large workspaces, using realistic fixtures and EXPLAIN evidence.

Completion means both a genuinely simple new workspace and a safely migratable existing workspace, with consistent creation defaults across UI/backend, honest connector restrictions, durable reviewed transitions, passing acceptance evidence and synchronized truthful KB documentation.

## 14. Preparation verification record

- Both worktree paths, branch names and baseline revisions verified with Git; existing worktrees left untouched.
- Independent read-only document review found no major completeness or internal-consistency issues; it was not a runtime security certification.
- `git diff --check` passed in both worktrees; the implementation plan was separately checked for trailing whitespace and final newlines.
- The initially drafted KB-specific plan and its index link were removed per user direction. The brian-kb worktree is clean and reserved for documentation derived from design and implementation.
- No dependency installation, database migration, application test, customer-data access, implementation change, commit or push was performed in this preparation.
