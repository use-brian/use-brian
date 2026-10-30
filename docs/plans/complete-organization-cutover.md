# Complete organization cutover

This specification completes the runtime transition after the reviewed legacy
cleanup. It does not equate an empty General inventory with a working `ready`
workspace. The implementation must preserve ordinary creation, Office use,
existing workflow execution and authorization during the transition.

## Invariants

- Prepare and apply through authenticated, revocable human sessions. Only the
  current workspace owner can finalize a cutover. Review expiry, policy revision,
  selected default department, inventory fingerprints and runtime capabilities
  are part of the review, not caller-supplied certification.
- No change to clearance, private visibility, Projects, connector credentials,
  provider exposure or saved execution consent follows from activation.
- Existing schedules keep their identifiers, cadence, delivery targets, history,
  state and exact department/Project bindings. Convert their saved authoring
  authority into the same snapshot and claim protocol as newly created schedules.
  Revalidate that saved authority against current grants. Never mint a claim in
  the migration: the normal dispatcher claims after commit.
- Freeze the cross-family inventory and all relevant writers for the short apply
  transaction. A quiet inventory page is not a live admission barrier. Refuse an
  unknown producer or unresolved binding; never discard a family from the
  readiness calculation just to make activation succeed.
- A failure rolls back the entire transition. An acknowledged retry returns the
  committed receipt and does not change schedules or advance policy a second time.

## Permission-model routing

Permission model v2 is already authoritative when `department_read_v2` is true.
As the v2 canonical writer states, access mode, classification mode and legacy
Team scope mode are not inputs to its write rule. Setup completion must not
switch a v2 workspace into the superseded, partly implemented mode-admission
protocol. In particular its source-free Office-only gate must not disable
ordinary template generation, imports or copies which the department engine
already governs.

Keep the persisted setup state truthful. Read the permission-model flag alongside
it and explicitly select the appropriate runtime, rather than returning a fake
legacy policy. Classic ready-mode admission remains unchanged for workspaces on
the pre-v2 rollback model. V2 continues to enforce the current department row
rule, source/parent floors, private visibility, Project restrictions, provenance,
holding, immutable snapshots and authenticated principal checks. Only the
superseded mode-specific restrictions are model-gated; no source, credential,
retention, Office ACL, scope-version or pinned execution guard is removed.

Canonical v2 Office shell creation admits the actual empty draft destination,
including templates. Human generation saves the admitted shell envelope in the
job rather than the raw request's omitted labels. Ambient retrieval is recorded as exact source evidence before construction; publication rechecks it and records Office source provenance in the same transaction. The established generation,
import, compilation, copy, publication, live editing and release paths retain
all of their resource-specific authorization and classification. Source/template
selection must still be authorized, and generated output must inherit all
material read. No source-derived content receives a source-free proof.

The SQL backstop for the superseded creation-receipt protocol must select the
same model as the TypeScript writer. Existing v2 department stamping, row
policies and derivation guards stay enabled. Tests must show both successful
operations and the same authorization denials before and after completion, not
merely absence of an obsolete error.

## Readiness and activation

Review returns concrete remaining blockers with IDs and content-free evidence.
It covers all inventory families, principal defaults, configured connectors and
intake, enabled workflow triggers, live/queued jobs and old-worker barriers. The
server's compiled capability manifest and positive runtime tests determine
support. A mode change alone never claims a missing producer implementation.

Apply locks workspace, policy, review, principals and dependent resources in the
canonical order. It rechecks the entire review, converts eligible schedules,
advances `setup_state` using the existing audited policy writer and records a
content-free receipt atomically. It neither deletes retained records nor forces
strict classification. Existing policy audit and invalidation notifications
remain enabled.

## Required validation

Use the guarded disposable PostgreSQL fixture with the current department read
model, real application role, actual authenticated route and worker/store paths.
Cover successful generation and publication for every Office family with sources
and a selected template, copy/import/release paths, existing event workflows,
schedule claims and dispatch after migration, all preserved data/bindings and
expected authorization denials. Test concurrent admission/policy changes, source
revocation/holding, stale previews, expiry, cancellation, replay and rollback at
each transaction boundary. Do not replace positive tests with assertions that
unsupported operations refuse. Run the repository unit suite and smoke test.

Production deployment and cutover remain explicit user actions. The PR must be
based on and target `develop`; it must not contain workspace-specific data or
local cleanup artifacts.

## Dispatch leases at the transition

Before a previously unpinned job executes, the poll worker assigns an opaque
dispatch lease. Nag writes and outcome/failure bookkeeping compare that identity;
they cannot disable, delete or overwrite a row converted to a pinned schedule.
Cutover refuses any outstanding dispatch lease or active run of a schedule it
would convert, including an expired discovery awaiting normal recovery. No lease
or claim is fabricated by migration. Existing cadence, nag state and delivery
fields are preserved, and the normal dispatcher claims the converted row.

The final barrier first validates the owner without row locks, acquires the short
workspace/table writer barrier, then locks/rechecks workspace, policy, session,
review and selected resources. It refuses contention rather than retaining locks
across confirmation. Inventory is bounded to 5,000 records per family. Monotonic wall-clock checks bound review/apply work; PostgreSQL 17+ additionally enforces a 20-second transaction timeout, so a slow inventory cannot retain the global writer barrier indefinitely. All API
and worker processes must run the cutover-capable release before activation;
deployment itself is not performed by the migration client.

## Owner completion surface

Organization migration progress exposes Finish setup only to the actual workspace
owner on permission model v2. It uses the normal revocable browser session and
prepares a server review for the currently displayed default department. The
confirmation shows that retained content and grants stay unchanged, the number
of schedule conversions, the reviewed inventory count, revision, hash and expiry.
An authority refresh cancels confirmation; apply rechecks all evidence. Blocked
reviews display remaining record IDs and never offer activation. Network retries
reuse the confirmed review. Completion refreshes mode, registry and migration
progress through the normal organization event/cache path.

Completed setup also reconciles fully applied Department migration plans in the
same transaction, so the refreshed list does not retain obsolete finalizer
blockers. Paused/cancelled and empty plans retain their state. A plan targeting
a different mode remains explicitly unresolved rather than claiming that its
original target was applied.
