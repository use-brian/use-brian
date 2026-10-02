# Workspace access modes — implementation handover

> **Status 2026-10-02:** direction superseded by the platform plan `docs/plans/permission-model-v2.md` (§12 adopts this branch as its starting point); this note is kept unrewritten as the branch's history.

## Checkpoint and ownership

- PR: https://github.com/use-brian/use-brian/pull/395 (**draft**).
- Source: `feature/workspace-access-modes`; target: `develop`.
- Original implementation checkpoint: `1acdd2fe`, followed by handover commit `e07f3696`. Current follow-up: integration commit `a3e8b99f` and partial schedule-review checkpoint `c41f93eb`.
- Latest `develop` integrated: `e824defd`. Unpublished feature migration filenames shifted **+1**, to 621–647, preserving upstream migration 620. Historical migration numbers in the domain summaries below refer to the original checkpoint; add one when locating those files now (original 639 was unused; current 640 is unused).
- Original baseline: `c555316a132860799a6a8fb366a97049bf861ff8`.
- Main worktree used: `/workspace/brian-access-modes/use-brian`.
- Separate KB worktree: `/workspace/brian-access-modes/brian-kb`, branch `docs/workspace-access-modes`, baseline `ea07cca`. It remains unchanged; no KB commit or push was made.
- Feature implementation has stopped at the user's requested checkpoint. No child implementation job remains intentionally running. The last schedule-edit job was interrupted; its partial changes are included, not represented as complete.

**This is not a finished feature, a merge recommendation, or authorization to activate Simple mode.** Fixture policies marked ready are test setup, not production readiness certification. Existing permissions must remain unchanged until reviewed migration. Fail-closed paths are temporary safety, not completed feature coverage.

## Read first / immediate blockers

1. **Numbering collision resolved in the follow-up integration.** `develop` at `e824defd` is now merged. Its `620_drop_email_archive_trgm.sql` is unchanged; feature schema starts at `621_workspace_access_modes.sql`. Executable filename references were updated. Upstream upload/intake, Feishu and workspace ownership UI changes are included; Office publication now uses the upstream storage-quota port. The integration typechecks, but broad runtime verification remains incomplete.
2. **Interrupted schedule-edit prototype (now migration 647, formerly 646).** `647_workflow_schedule_edit_review.sql`, `workspace-access/workflow-schedule-edit.ts`, and associated workflow store/route/core-contract edits remain partial. The brief resumed work added hash-bound receipts and replay handling before being stopped again at the user's request. In particular, the new reviewed lane in `withWorkflowWrite` switches to the owner pool: audit/replace that authorization boundary before using it. Typechecking is not independent security review or positive prepare/apply certification.
3. **Known current test failures.** The follow-up four-suite PostgreSQL run reports **50 passed / 2 failed**. `operational-admission.integration.test.ts` (around line 609) expects `workflow_schedule_edit_not_ready` but receives `workflow_schedule_review_required`. The historical upgrade test in `workspace-access-modes.integration.test.ts` (around line 60) cannot drop migration tables because newer objects depend on them. The earlier two schedule-reapproval expectation failures no longer occur in this run. Preserve the no-unreviewed-edit invariant and fix historical fixture isolation; do not merely weaken assertions.
4. **No completed mode finalizer/provisioning certification.** `migration-service.ts` still exposes `full_inventory_required`, `intake_certification_required`, and `mode_finalizer_unavailable`. Do not remove these constants merely to make the UI look complete.
5. **Assistant transfers remain blocked.** Migration 640 and the transfer helper intentionally deny even empty-shell transfers pending non-FK dependency-writer serialization. A snapshot emptiness scan was found unsafe. HTTP preview/selection/error handling and destructive-removal prevention exist, but positive transfers are not finished.

Primary references:
- `workspace-access-modes-and-migration.md`: authoritative requirements, M0–M6 and AM01–AM22.
- `workspace-access-modes-admission-manifest.md`: **baseline** writer inventory, not a current coverage certificate.
- `workspace-access-modes-connector-contract.md`: provider authority constraints.
- `workspace-access-modes-implementation-status.md`: historical bounded checkpoints; use this handover for the later 640–646 work and current failures.

## Commit map

| Commit | Functional area |
| --- | --- |
| `fd076889` | Mode policy, shared contracts, transactional admission, principal/transfer guards |
| `57baaad3` | Durable reviewed migration, consolidation, metadata inventory |
| `ae3409ed` | Canonical brain/task/entity writes and source evidence |
| `a6e71706` | Knowledge bindings, durable sync fencing and reconciliation |
| `afcf8cd0` | Derived files, uploads, PDF intake, recordings and segments |
| `c01e9003` | Authored Office shells and prompt-only document publication |
| `7b78f7cf` | Authored page placement and plain canonical page copy |
| `6d513eb1` | Shared/personal web session admission and SQL context checks |
| `cd519246` | Scheduled execution, task-derived goals, **WIP** schedule-edit reviews |
| `368a803a` | Configured scheduled intake and atomic extraction publication |
| `ed1f89a5` | Explicit external-key authority and credential-version fencing |
| `9979581f` | Reviewed Shopify setup/reconnect and durable token rotation |
| `9b61e296` | Protected mode/migration/Shopify UI and four locales |
| `2f2f6ce0` | Production boot integration |
| `1acdd2fe` | Design, manifests and historical implementation status |

These are functional checkpoints of a coupled change set. Validate the branch tip; do not assume every intermediate commit is independently deployable.

## Implemented bounded paths

Paths below are relative to `packages/api/src` unless stated otherwise.

### Policy and migration

- Simple and Departments use the same backend. Simple selects a canonical department; classification mode and principal scope modes remain separate.
- Migrations 620/624/625 establish compatible legacy policy defaults, eligible principal admission, authority serialization and seven-family creation receipts. Default-department changes use canonical reviewed commands.
- `workspace-access/migration-service.ts` supports bounded principal and resource proposals, canonical simulation/review/apply, exact confirmations, expiry, idempotency and pause/cancel/resume. Empty inventory-only plans remain drafts. Advisory-lock work reuses its reserved connection; max-one-connection regressions exist.
- `workspace-access/migration-inventory.ts` now has **73 fixed metadata-only adapters**, reconciliation hashes, bounded pages, deletion tombstones, before-cursor insertion detection, live actor protection and explicit unsupported-action flags. A quiet family is not a global snapshot or intake barrier.
- Canonical scope consolidation preserves private/assistant/sensitivity/Project floors and revalidates source and descendant evidence. Held/history/unprovable cases are not silently released.

### Content, knowledge and pages

- Canonical task, memory, episode, entity, link and authored-file stores admit within workspace-first transactions. Derived memory/entity/file paths retain exact source versions, partitions and label floors; added labels and predecessor mutation still require mutation authority.
- `db/knowledge-store.ts`, `workspace-access/knowledge-sync-admission.ts`, migration 632 and core `knowledge/sync-worker.ts` implement immutable source bindings and local/GitHub sync with durable exclusive run leases. Every supported mutation is fenced; error handling cannot rewind a newer cursor. Interrupted runs require full reconciliation. Truncated GitHub inventories fail before publication/deletion. Legacy worker SQL is privileged invoker-only; app wrappers require current bound-source authority.
- `db/page-placement-admission.ts`, saved-view store and views routes support source-free human placement and **plain** canonical page copy. Locked current snapshots are restricted to plain text/headings/dividers. Media, links, nested pages, structured blocks and unknown source metadata are rejected rather than copied without evidence. No invented saved-view hold kind was added.

### Files, media and Office

- Migrations 634/636 cover canonical derived files and upload admission pinned at start and rechecked at completion. File publication and upload ledger completion are atomic. Bytes stage before publication; lost COMMIT acknowledgment retains possibly published bytes.
- Migration 637 and `db/office-pdf-intake.ts` reserve private pending PDF sessions before asset writes, validate owned sources and publish atomically. Partial failures remain hidden and recoverable. Root holds and source invalidation also protect child rows, collaboration snapshots, nested jobs/comments/audits and bound file delivery.
- Migration 638 plus `office/prompt-only.ts` and `office/generation-publication.ts` complete source-free **document** generation without implicit knowledge/brand/template loaders. File, artifact version/head, live document, permission binding, completion event and job status commit in one app-role transaction. SQL checks both sides of the output binding. Late authority loss and cancellation prevent publication. Tests use fixture model/converter ports, not live external generation services.
- Migration 642 and `db/recording-intake-admission.ts` support canonical file-to-recording adoption, segment publication, transcription and private derived transcript files. Source holds and current Office/file ACLs propagate through cycle-safe lineage. Actual HTTP queue/worker paths use the authenticated requester, not the historical creator. Status bookkeeping does not mutate Episode source evidence. Child segments close before parent retirement in the same transaction.

### Sessions, keys, automation and intake

- Migrations 633/645 and `workspace-access/session-create-admission.ts` support authenticated shared and personal web roots. Private creation does not receive ordinary shared defaults; null and saved bindings survive resume. SQL independently validates current member/assistant Team/Project/clearance authority, including paired receipt/row forgery cases. Personal transport proof is internal and session-bound.
- Migration 644 and `db/external-key-admission.ts` support explicit finite Brain-key bindings and secret-only rotation. Key execution retains the credential proof actually authenticated; rotation cannot substitute a new hash during context resolution. Private/Project boundaries and mid-call revocation have tests. Ready assistant API-key creation and authority-changing updates remain restricted pending finite-binding support; keys do not inherit ordinary-member defaults.
- Migration 635 implements atomic authenticated scheduled-workflow creation, saved consent, just-in-time claims and transactional run admission. Completion/failure and nag updates are claim-fenced; lease expiry is separate from cadence. Nag resolution compares the observed cycle and preserves failure counters. This previously reviewed slice must now be regression-tested against the interrupted 646 edits.
- Migration 643 and `db/goal-task-{producer,triage}.ts` support bounded task-derived goals with the actual executing actor and exact task evidence. Ready-mode triage uses only static public capability descriptions; dynamic connector metadata is legacy-only. Legacy and ready insertion races reject instead of switching authority models.
- Migration 641 and `ingest/programmatic-terminal.ts` support session-authenticated configuration and scheduled Brain-key intake. Supported Episode/Pipeline-B summaries, memories, new non-CRM entities and admitted tasks publish with batch completion on one claimant transaction. Savepoints roll back partial candidate writes even when the real poll worker catches errors; deferred checks verify receipts and completion. Other candidate variants remain pending/fail-closed.

### Connectors and frontend

- Shopify production OAuth start/callback/manual routes, protected reconnect projection and UI use encrypted pending setup, bound nonce/session/workspace, exact account/root/permission consent, and transactional activation. Reconnect preserves saved bindings. Review evidence is reauthorized before disclosure and has server lifetimes capped by setup/session expiry; the UI subtracts elapsed request time.
- Managed Shopify rotation persists a durable pre-exchange fence. Verification retries reuse encrypted returned credentials, never re-exchange a consumed refresh token. Lost responses require reviewed recovery. All real-store MCP paths use the durable coordinator, not generic refresh fallback. Slow verification/publication lifetime checks are covered.
- `apps/app-web` includes protected migration progress/reviews, mode-aware shared chat/manual workflow creation, ready-Simple summaries/navigation, admin recovery, Shopify consent/reconnect, cache invalidation and `en`, `ja`, `zh-cn`, `zh` strings. Follow `apps/app-web/AGENTS.md` and the component map for further work.

## Remaining work by lane

| Lane | Concrete remaining work / starting points |
| --- | --- |
| M0/A01 | Finish actual writer certification, readiness-backed new-workspace Simple provisioning and linked default Teamspace/department package. Start `db/workspace-store.ts:create`, policy readiness and the admission manifest. Do not activate by feature flag or member count. |
| A02 | Certify/serialize non-FK assistant dependency writers, then implement reviewed transfers/adoption/removal. `db/assistant-transfer-admission.ts`, migration 640, `routes/workspaces.ts`. Private instructions, direct caps and old history cannot silently become team-owned. |
| A03 | Bound Brain-key/API/channel/public/draft/session-source producers, message admission and relevant old-worker barriers. `db/sessions.ts`, session admission helper and callers. Private exemptions are not family-wide certification. |
| A04 | Chat/channel caches, live/upload recording variants, file indexing callers, local-directory imports and remaining session/page-derived files. `db/file-store.ts`, recording/segment stores, upload and import producers. Preserve positive paths above. |
| A05 | Source-bearing page copies/imports/reparenting, generated/recording/workflow pages, linked-Teamspace provisioning and structured entity/blueprint writers. `db/doc-entity-store.ts`, `blueprint-records-store.ts`, saved-view/page helpers. |
| A06 | Source/template-backed generation, presentations/spreadsheets, imports/copies/restores, resource/library/template writers and live/offline/release paths. `office/service.ts`, import workers, Office template/release stores. |
| A07/A08 | Session-sourced entity/memory producers, additional link endpoint/derivation kinds, CRM/bulk/app writers, maintenance workflows and remaining source/transaction closure. Audit `scoped-summary-store.ts` lock ordering and embedding claim/write-back fencing. |
| A09 | Finish/review migration 646 and exact prepare/apply contracts; native goal/workflow/scheduling, parent/session/recipe goals, event/webhook sources and broader clone/enable/reapproval. Existing runs must retain saved authority. |
| A10 | CRM candidates, edges, reuse/supersession, realtime/OAuth/Home-app and remaining configured intake. Connection activation alone does not admit ingestion; Shopify still does not implicitly enable it. |
| A11 | Finite assistant API-key creation/use, other key/rebind/transition paths, chat links, guest/page grants and external-principal adapters. Never enroll external principals into Simple's ordinary default membership. |
| Connectors | Other providers/storage/mailbox/MCP/CLI/channel paths, remaining share/transfer/legacy identity enrollment, ingestion activation and a separately proven approved provider-exposure design. Generic finite/Project catalog denials remain. |
| M3/M4 | More reviewed remediation families (connectors, sessions, keys, Teamspaces, jobs, queued intake, held exclusions), complete live cross-family inventory tail/barrier, short atomic mode finalization, contraction invalidation and reviewed compensation. |
| M5/M6 | Remaining creation UX, pilot/proposal/recovery, browser/Electron/offline/cross-tab verification, lint, large-inventory/concurrency/isolation and full AM01–AM22 evidence; then architecture/product docs and KB publication. |

## Invariants not to relax

- One authorization backend; mode, classification and principal scope remain independent.
- Current actor and transaction-scoped authority; never infer human provenance from `created_by`, owner IDs, request/model JSON or a globally attached store identity.
- Workspace lock before dependent rows; sorted workspaces for cross-workspace operations. Reuse the transaction client, especially with a one-connection pool.
- No broad owner-connection escape, system-bypass writes, global relation SHARE locks or generic invalidation grants.
- Source floors include private ownership, assistant partitions, sensitivity, departments and Projects. Read-derived authority is not permission to mutate predecessors or add labels.
- Defaults apply to genuinely new unbound eligible roots, not resume, rotation, retry, queued jobs or existing sessions.
- Reviews are exact, expiring and current-actor/source bound. Pause/cancel stops pending work; completed receipts remain. No implicit reapproval.
- Treat bytes, child tables, cached/live projections and external delivery as authorization surfaces, not merely root-row reads.
- No activation until every required writer/barrier and final-inventory/readiness check is evidenced. Bounded tests and quiet inventory pages are not that evidence.

## Verification record and reproduction

### Current checkpoint checks

- Core and channels builds: passed on the integrated follow-up.
- API typecheck: passed after integrating the upstream quota port and rebuilding channels.
- Web and desktop typechecks: passed.
- `git diff --check`: passed; commits ran without bypass flags.
- Current focused real-PG run: **50 passed / 2 failed**, four suites: `workspace-access-modes`, `resource-admission`, `operational-admission`, and `workflow-authoring-single-connection`. Migrations applied successfully with unique renumbered filenames; the historical replay fixture and schedule-edit expectations fail as recorded above.
- Earlier checkpoint's six-suite run: **68 passed / 2 failed**, including external keys, shared/personal sessions and inventory. This is historical evidence, not a rerun of those domains after integration.
- Home-app authority mock regression fixed; its five unit tests pass.

### Earlier evidence (not additive or final-tip certification)

- Through 638: 352 PG tests / 20 suites passed.
- Later Shopify/PDF/inventory check: 81 PG tests / 6 suites plus 15 production Shopify PG tests passed.
- Through-643 broad run: 473 passed / 2 failed because migration 640 invalidated old direct-transfer fixtures. Those fixtures were subsequently rewritten to assert the real transfer barrier, not disable it; later five-domain run passed 101 tests. The entire broad run was not rerun after every subsequent change.
- Focused later lane reports include recording/file/derivation regressions, intake, goal, key and personal-session tests. Independent reviews were bounded by lane, not a whole-branch security sign-off.
- No complete AM01–AM22 run, final package lint, live OAuth/model-provider certification, browser/Electron visual acceptance, or full offline/isolation report is claimed.

The `/tmp` logs below exist in the original environment only and are **not portable artifacts**: `/tmp/access-current-stage-{core,channels,api,web,desktop,pg}.log`, `/tmp/access-checkpoint-{core,api,web,desktop,pg}.log`, `/tmp/access-reviewed-through638.log`, `/tmp/access-reviewed-through643.log`, `/tmp/access-643-final-domains.log`, `/tmp/access-638-shopify-pdf-final.log`, `/tmp/access-shopify-production-final.log`, `/tmp/access-644-home-authority.log`. Reproduce results from committed tests rather than relying on those files.

```sh
cd /workspace/brian-access-modes/use-brian
corepack pnpm --filter @use-brian/core build
corepack pnpm --filter @use-brian/channels build
NODE_OPTIONS=--max-old-space-size=12000 corepack pnpm --filter @use-brian/api typecheck
NODE_OPTIONS=--max-old-space-size=12000 corepack pnpm --filter app-web typecheck
NODE_OPTIONS=--max-old-space-size=12000 corepack pnpm --filter app-web typecheck:desktop

# Original environment: pnpm wrapper and PG18/plugin binaries live under /tmp.
# Recreate these on a new machine; do not test against a production database.
PATH=/tmp/brian-access-modes-bin:$PATH node scripts/crm/local-fixture.mjs \
  --pg-bin /tmp/access-modes-pg-run -- \
  pnpm --filter @use-brian/api exec vitest run \
  --config vitest.integration.config.ts \
  src/db/__tests__/workspace-access-modes.integration.test.ts \
  src/workspace-access/__tests__/resource-admission.integration.test.ts \
  src/db/__tests__/operational-admission.integration.test.ts \
  src/db/__tests__/workflow-authoring-single-connection.integration.test.ts \
  --maxWorkers=1

corepack pnpm --filter @use-brian/api exec vitest run \
  src/brain-mcp/__tests__/agent-task-authority.test.ts
corepack pnpm --filter app-web exec vitest run src/components/workspace-access
git diff --check
```

Use exact Vitest files and sequential PG workers. `pnpm test -- ...` can accidentally select the entire suite. Skipped tests, injected-query fixtures and mock external services are not real authorization/provider evidence. Generic edit-tool diagnostics were unreliable here; use the explicit package typechecks.

## Suggested continuation order

1. Fetch the feature branch and review the PR's current checks. `develop` through `e824defd` and the migration renumbering are already integrated; check for newer upstream changes and verify intake/ownership behavior. Do not force-push or rewrite published commits as part of routine continuation.
2. Finish or explicitly quarantine the interrupted 647 (formerly 646) prepare/apply prototype. Add positive and negative real-HTTP/app-role tests for reviewed edits, stale/expired/session-revoked review, scope broadening, duplicate/lost-response apply, actor changes, claims/runs, and one-connection execution; obtain independent review.
3. Re-run the combined current tree and fix all observed regressions before adding more admission families. Add reproducible CI coverage rather than aggregating historical counts.
4. Close remaining canonical adapters and SQL barriers by the lanes above; update inventory/remediation coverage as schemas evolve. Coordinate disjoint file ownership when working in parallel.
5. Implement M3/M4 live closure and reviewed transitions, then readiness-backed provisioning. Audit every AM01–AM22 requirement against actual code and execution evidence.
6. Complete remaining UI/end-to-end/isolation/lint checks and publish the KB from verified behavior. Only then reconsider draft/merge/rollout status.
