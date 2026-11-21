# Canonical conversation store source

These reviewed templates generate the forward migration
`8269_canonical_conversation_publication.sql`:

```sh
node packages/api/scripts/conversation-store/build.mjs
node packages/api/scripts/conversation-store/build.mjs --check
```

After release, change behavior through a new forward migration. Historical SQL
is immutable. CI and the tagged build regression check the current generator.

The in-progress durable buffered-publication slice has a separate forward owner:

```sh
node packages/api/scripts/conversation-store/build-publication-recovery.mjs
node packages/api/scripts/conversation-store/build-publication-recovery.mjs --check
```

It generates `8272_durable_conversation_publications.sql` from the existing
writer/completion templates, `publication-recovery.sql` and its frozen reviewed
predecessor manifest. Exact literal body segments and named typed dependency
slots authenticate the predecessor before mutation; unrestricted numeric or
owner-name substitution is not permitted. The canonical session policy owns
initial shared-web eligibility. The original six-argument entry remains for
unmigrated consumers; the explicit seven-argument entry binds a buffered effect
to its atomic exact-frame receipt. Generation equality is only artifact
verification. Ordinary-owner migration, real authenticated process-death/reopen,
duplicate/Stop/constraint gates and physical qualification remain required.

Generation also checks the complete reviewed pin occurrence inventory, including
repeated opening and closing references. Missing/extra slots, known dependency
hashes left literal and unreviewed hash literals refuse; exact identity/context
checks still apply. Regression fixtures may validate a scratch manifest through
`--validate-manifest <path>` without writing a migration. Successful catalog
guards do not replace execution of the real capture and publication boundaries.

`reader-predecessors.json` retains only the two authenticated guard descriptors
needed from the retired 8267 generator. The generator checks the historical
migration checksum and each installed executable contract before replacing any
consumer. It retires superseded functions with RESTRICT only after verifying
that no surviving body or catalog pin depends on them.
The standalone covered-session evidence facade is also retired; its portable
body, metadata and grants are authenticated before deletion. Private covered frame helpers remain only for their existing general-source
consumers. Five embedded Memory/dependency/reference/covered comparators are
retired: their authenticated leaf records move to the existing canonical registry.
Its source FK and trigger contracts remain fresh; the four repeated queue clauses
are retired with their tables. Known consumers are rewritten explicitly;
unknown consumers abort the migration. Runtime installation verifies that
protected registry before invoking its owner.

Capture uses one bounded dependency graph with distinct current scopes and
immutable obligations. Publication uses the same requirements and a format-2
manifest, followed by the independent completion proof. Memory history retains
its purpose-specific admission; an ordinary source cannot inherit its exception.
Ordinary Memory field envelopes share the canonical graph validation and retain
the family projection for masks, cohorts and successors. They do not re-enter
the recursive recorded-field reader; the unused memoryStatement branch is gone.
No allow result is retained across operations. Migration replay, actual app-role
reads/writes, fault injection, and HTTP/database cost measurements are required
in addition to deterministic generation.

The existing native member field-permission owner evaluates distinct read/write
rules once per invocation and projects them to the original sorted masks. Active
role windows and membership are read again on every invocation. The old per-field
loop is replaced, with no retained authorization state. Additional legacy
comparators embed executable bodies; their reviewed portable predecessor
contracts are authenticated before propagating this change. Runtime checks are
not bypassed to update those migration-time contracts.

Canonical publication also replaces the old field-work scheduler. The event
collector runs before the named field constraint in both deferred and immediate
modes. Unowned writes retain the original generic per-event validator. The old
work/header tables, sequence, batch and covered validators, enqueue function and
specialized reference fallback are dropped with RESTRICT. A nonempty predecessor
queue aborts migration; no pending work is discarded. Real constraint-mode,
savepoint, duplicate/upsert, 4,097-event, permission and restart tests cover the
receiving boundaries rather than the deleted queue representation.

Title publication now enters the same batch/frame/completion owner as transcript
and annotation output. It retains strict source version/envelope checks, manual
protection, generation/head CAS and fresh completion. Grouped title acquisition
uses canonical evidence rather than the old file-evidence entrypoint.

Migration prerequisites normalize only reviewed embedded dependency pins. The
owning body, metadata and grants still require exact authentication. Dependencies
outside the authenticated contract retain a fixed raw-body hash. The historical
owner-only default-grant profile is recognized narrowly; new private helpers
explicitly revoke PUBLIC and app_user before public entrypoints regain EXECUTE.
Fresh and legacy PGlite, populated PostgreSQL restart and negative predecessor
mutation cases exercise this portability boundary.

Executable/table contracts belong to writer entry/exit and independent completion
entry/exit. Event collectors, field references and event validators preserve
their exact data/context checks and pinned executable fingerprint without
repeating the full table contract per event. Independently invoked Page callbacks
retain the fingerprint fence before delegation; completion cannot retroactively
authorize an intervening callback. Debt
deletion retains the canonical registry, which includes the publication contract.
The installer authenticates each predecessor before rewriting these private
callees and repins their complete catalog records. Real commit/named-completion
drift tests cover every transferred helper.

Title reopening uses the existing current-head reader with canonical revision
capture. Private/file/empty-query title facades, their context wrappers, and two
private comparators are retired. Authenticated leaf records move to the existing
registry before deletion. The reader preserves workspace-before-head lock order;
original-ceiling acquisition and later delivery remain independent operations.

`publication-recovery-legacy-acl.sql` owns the two inherited-EXECUTE phases of
`build-publication-recovery.mjs`. Its finite manifest profile names eight helpers
and their immutable CREATE/REPLACE history. The profile recognizes source-known per-schema
application grants, including cleanup of that default after the helper was
installed. The current default must be absent or exactly the reviewed grant. The
before-auth phase validates the default context and stages only source-declared
ACL alternatives. After every predecessor, current guard and original fingerprint
consumer has authenticated, the after-auth phase removes only the declared
application grant and checks each complete expected successor row. Six PUBLIC
profiles retain PUBLIC execution; both private profiles become owner-only. Every
default-privilege row remains unchanged. Successor private helpers explicitly
revoke PUBLIC/application inheritance before comparison with source definitions.

The manifest also names all 38 constraint-namespace substitution sites. Each
`constraintNamespace` slot identifies the public relation and constraint by name,
requires that constraint to belong to the public namespace, and renders that
namespace's local OID. The source compiler checks the exact roster and site
bindings. Other catalog fields and body bytes remain exact; this is not a global
replacement of namespace numbers or a target-derived catalog expectation.

The retained guard is authenticated separately by `publication-recovery-retained-guard.sql` before invocation. Its body comes from the immutable 8267 declaration and exact named 8269 retirement; a trusted compiler reference supplies the complete expected metadata and private ACL. The installer independently validates the private registry read boundary and surviving two-member roster. ACL labels bind actual owner, PUBLIC and application OIDs; foreign role names cannot stand in for these principals.

`terminal-publication.sql` owns the finite format2 candidate validator and exact
native selected-output subset. `terminal-lifecycle.sql` owns domain-separated public
turn correlation and the shared original-token lock/fresh classifier for claim,
reclaim, cancel and release. Both are source-authenticated into unpublished 8272.
Requested command bytes stay digest-bound; SQL alone selects effective stopped
transcript retention with no terminal fields. Format1 behavior remains unchanged.
The application never fills a terminal marker after COMMIT or retries a model/tool
callback to reconcile an uncertain acknowledgement.

Historical requirement conversion has a separate forward owner:

```sh
node packages/api/scripts/conversation-store/build-conversion.mjs
node packages/api/scripts/conversation-store/build-conversion.mjs --check
node packages/api/scripts/conversation-store/prepare-conversion-predecessor.mjs --check
```

It generates `8273_conversation_requirement_conversion.sql`. The applied 8272
checksum remains frozen. The predecessor profile is reproduced from that
source compiler in a temporary module without opening a database. Its complete
296-function poststate, exact body/metadata/ACL contracts, source-owned table and
RI profiles, and original persistent pin consumers authenticate before
conversion enrollment. The 17 source-defined publication successor bodies have
an explicit empty hash-literal inventory; future sites require a reviewed
profile. No target catalogue value supplies an unverified expected program.

`conversion.sql` preserves ordered immutable original and declared tuples
separately. The installer binds the maintenance compiler identity to the exact
module SHA; callers cannot supply another compiler identity. Independent source
references verify the new tables, row/custom types, indexes, defaults,
constraints, enrollment and child/parent RI triggers. The canonical registry
retains its original guards and propagates only source-declared new contracts.
No compiled reader or ready flag is activated by this migration.

A page selects at most 32 units and bounds measured descriptor/receipt values to
16MiB. `sourceBytes` also records acquired lookahead witnesses. Acquisition and
hashing of a complete original adapter can exceed16MiB; this is not a total
physical-work bound. Native 4096 eligibility is not a supported-content limit.
Original adapters remain available; all-family conversion, erasure/restore,
reader retirement and whole-turn feasibility require their own qualification.

The native installation owner imports `authenticateConversationInstallation` from
`installation-authentication.mjs` before runtime activation. The source-pinned
8274 verifier checked the exact 309-function closure (including its independent
retained guard), complete input metadata and source-defined private references.
It owns a short transaction on a connected idle ordinary-owner pg client and
accepts prepared or active canonical role state without changing that state.
Its compiler namespace is distinct from migration helpers and is removed before
return; repeated checks on the same migration connection are supported. The
finite generated-recipe mutation check is not a general SQL authorization parser.
Logical archive execution and durable inputtable registry conversion remain
separate recovery requirements.

The forward `8274_inputtable_executable_contracts.sql` installer is reproduced by
`node build-executable-record.mjs --check`. It source-authenticates all309
predecessor functions, refuses unknown registry/pin consumers and changes only the
canonical executable record representation plus its existing source-owned guard
and affected body pins. `executable-record.mjs` defines all30 fields and the
shape-before-projection contract; the two parse-tree values retain exact text.
`installation-authentication-8273.mjs` is the frozen historical compiler input,
not a current runtime fallback. The current authenticator verifies8274 and its
inputtable schema on every call, including repeated calls on one owner connection.
The rig recognizes exact historical/current ledger phases before comparisons.
Inputtable COPY does not complete portable restore: the existing backup owner must
preserve original proofs separately from trusted source-rendered target contracts
and import user facts only into trusted, quarantined schema.

### Reviewed harness / 8337 portable extension

The head roster now covers 813 migrations through 8337: 604 tables, including
all seven durable harness tables. The separately pinned 8273 cohort is unchanged.
`portable-restore-roster-8334.json` preserves the reviewed predecessor bytes.
`portable-harness-review.mjs` verifies their exact digest and adds only the seven
explicit names to produce `portable-harness-classification-8337.json`. This is
reviewed source input, never runtime catalog enrollment.

`installation-authentication-8337.mjs` pins the three numbered migration recipes
and the expected artifact's bytes. It composes 8334 authentication with the exact
harness/admission catalog, checking all three ledger receipts in the same
repeatable-read authentication snapshot. Unknown harness routine/table names,
extra overloads, altered actor ACLs, policies, columns, constraints, indexes and
triggers refuse. The scope includes the altered Project scope and admission
function/trigger, not only newly created harness tables.

The source-profile unit test renders the full predecessor proof before checking
the 8337 catalog binding. It has a 15-second timeout because rendering can
exceed Vitest's five-second default on the CI runner.

Reproduce or check both artifacts ONLY on a newly created disposable fixture:

```sh
node packages/api/scripts/conversation-store/build-portable-harness-catalog.mjs --pg-bin <PG18>
node packages/api/scripts/conversation-store/build-portable-harness-catalog.mjs --pg-bin <PG18> --check
```

This generator accepts no database URL/catalog input, verifies source pins and
reviewed classification before cluster creation, checks fixture ownership and
ordinary-owner privileges, builds both outputs before writing, and always
cleans up its cluster. Check mode also authenticates the registered 8337 profile.
Expected field counts are fixed: 23 routines, 8 relations, 0 types, 11 triggers.
Source or expected-artifact changes require source review, never rebaselining
from a failing/live catalog. Generating new bytes does not authorize them: the
profile's expected-artifact SHA must also match.

Revisions, approvals, runs, evidence and audit are durable, not projections.
Approval/run `auth_session_id` values are opaque historical UUIDs, retained
exactly without a corresponding auth-session row or restored login capability.
`scope_id` is a generated column. All eight harness triggers are reviewed;
`harness_run_audit` is suspended as a derived effect so archived audit is imported
once. New reference cycles requiring restoration UPDATEs on immutable harness
history refuse pending a separate reviewed design. Full populated-history,
evidence, attribution and receiving-proof round-trip validation is owned by the
portable integration proof, not replaced by generator/unit success.

Portable brain restore has its own owner, `portable-restore.mjs`, beside this
registry module. `executable-record.mjs` exports complete registry records as
original source proof and compares signature rosters; restore never imports,
casts or repins them. The reviewed roster `portable-restore-roster.json` is
generated against a fresh shipped chain owned by the disposable fixture:

```sh
node scripts/crm/local-fixture.mjs --pg-bin <PG18> --ordinary-owner -- \
  node packages/api/scripts/conversation-store/build-portable-restore-roster.mjs --inventory <classification.json> [--check]
node packages/api/scripts/conversation-store/build-portable-restore-roster.mjs --markdown <platform>/docs/architecture/platform/portable-brain-restore.md [--check]
```

The pinned 8273 cohort roster `portable-restore-roster-8273.json` comes from the
same builder with `--cohort 8273_conversation_requirement_conversion.sql`, run
against a fresh fixture chain stopped before 8274 (756 entries, with an inventory
whose `ledgerCount` is 756); its digest is pinned in `pglite-portable-source.mjs`.
Every firing BEFORE INSERT trigger that can change the inserted row must be in the
builder's reviewed `originStamps` (suspended as `suspended:origin-stamp`, because
the value comes from origin-time state, such as the 8063 lease token a release
leaves behind) or `fixpointStamps` (fires, reproduces the archived row); an
unreviewed one refuses the build.
Every other trigger that fires during import (INSERT, or UPDATE on tables the
import updates) needs a reviewed verdict by function in `originValidators`
(suspended as `suspended:origin-validator`: the check reads origin-time state)
or `structuralValidators` (fires; the tables it reads are imported first, as
`validatorOrder`). Triggers on tables with deferred NULL placeholders that read a
deferred column or the whole row become `suspended:restoration-placeholder`.

Any new table, sequence, insert/update trigger or FORCE-RLS policy refuses
import until the roster is regenerated and reviewed. The builder also refuses an
inventory whose `ledgerCount` differs from the fresh chain and records the chain
head (813 entries, `8337_project_chat_creation_admission.sql`). The 8276 witness is
installation-derived (D7): a head import ends with the owner-only refresh, and an
8273-cohort transfer is refreshed by 8276 itself as the runner moves forward.
`portableTableDigests` returns the canonical per-table rows and record digests
for receiving comparisons. See the platform spec
`docs/architecture/platform/portable-brain-restore.md`.

The registry guard successor has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-registry-guard-successor.mjs
node packages/api/scripts/conversation-store/build-registry-guard-successor.mjs --check
```

It generates `8276_registry_guard_successor.sql` from the frozen
`installation-authentication-8274.mjs` recipe, the reviewed propagation and
`registry-guard-successor.mjs`. The guard's first statement compares the live
`(ctid, xmin)` identities and in-place flags of every catalog tuple its full
comparator reads with the owner-only `native_turn_contract_witness`. Equality
returns true; any difference runs the unchanged full comparator. Only the
owner-only `native_turn_contract_witness_refresh()` writes the witness, in the
same statement and snapshot as a passing full comparison. No authorization
result is stored. The joint preparation owner and the refresh become registry
members.
`installation-authentication.mjs` now verifies 311 functions, the witness
relation and canonical sets, and the full comparator independently. It reports
`witnessCurrent` without repairing it. Every later executable-contract
migration must whitelist the refresh as a reviewed registry consumer and end
with a refresh.

The durable completion header has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-turn-completion.mjs
node packages/api/scripts/conversation-store/build-turn-completion.mjs --check
```

It generates `8277_durable_turn_completions.sql` from the frozen
`installation-authentication-8276.mjs` recipe (which authenticates all 311
predecessor functions and the witness before any mutation), `turn-completion.sql`
(the `native_turn_completions` table and its four members),
`turn-completion-outcome.sql` (the successor body of
`native_session_expired_turn_outcome`) and `turn-completion.mjs`. The renderer
replaces the classifier only when the predecessor renders the exact 8272 body, and
adds the four members to the guard roster; the reviewed propagation then repins
every consumer, and the migration ends with the owner-only witness refresh.
`record_native_turn_completion` and `read_native_turn_completion` are the only
application ports; `native_turn_completion_scope` (the session SELECT audience)
and the immutability trigger are owner-only. No authorization is stored.
`installation-authentication.mjs` now verifies 315 functions: the 8276 closure
with the re-rendered guard and classifier, the four members compiled from source
into `pg_temp`, their exact ACLs and registry records, and the completion relation
contract (columns, constraints, indexes, triggers, owner-only ACL, RLS without
policies, recovery capture target).

The Page source-family adapter has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-page-closure.mjs
node packages/api/scripts/conversation-store/build-page-closure.mjs --check
```

It generates `8278_page_closure_adapter.sql` from the frozen
`installation-authentication-8277.mjs` recipe (a byte copy that authenticates all
315 predecessor functions and the witness before any mutation),
`page-closure.sql` (the member `capture_page_closure_evidence` and the row-lock
successor of `read_page_event_authority`) and `page-closure.mjs`. The renderer
adds the member to the guard roster; the reviewed propagation repins every
consumer, and the migration ends with the owner-only witness refresh. The
successor replaces only the exact 725 body of `read_page_event_authority` with
its 8013 metadata; it is not a registry member. The member admits a Page-derived
closure for the caller's own principal or returns NULL, in which case the
caller's complete source validator decides; nothing is stored.
`installation-authentication.mjs` now verifies 316 functions: the 8277 closure
with the re-rendered guard, the member compiled from source into `pg_temp` with
its exact ACL and registry record, and the exact successor body and metadata.

The query-domain visibility successor has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-query-domain-visibility.mjs
node packages/api/scripts/conversation-store/build-query-domain-visibility.mjs --check
```

It generates `8280_query_domain_visibility.sql` from the frozen
`installation-authentication-8278.mjs` recipe (which authenticates all 316
predecessor functions and the witness before any mutation),
`query-domain-visibility.sql` (the successor body of `conversation_dag_domain`)
and `query-domain-visibility.mjs`. The renderer replaces the member only when the
predecessor renders the exact 8269 body; the reviewed propagation then repins its
registry record and every consumer, and the migration ends with the owner-only
witness refresh. The only change is the frozen-visibility clause: a reader whose
assistant visibility does not contain the domain's frozen one admits the domain
only when every frozen point is unscoped or visible to it, before the unchanged
exact rescan. No member is added; `installation-authentication.mjs` still
verifies 316 functions and checks the successor body, metadata, ACL and registry
record. 8278 and 8279 belong to other owners; 8279, if it lands, must be ordered
against this chain.

The private-transcript floor successor has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-private-transcript-floor.mjs
node packages/api/scripts/conversation-store/build-private-transcript-floor.mjs --check
```

It generates `8281_private_transcript_floor.sql` from the frozen
`installation-authentication-8280.mjs` recipe, `private-transcript-floor.sql` (the
successor body of `private_session_display_parent`) and
`private-transcript-floor.mjs`. The parent is outside the canonical registry and
no contract pins it: the migration refuses unless the installed parent is the
exact predecessor body with its reviewed metadata, owner-only ACL and no pin
consumer, replaces it with `CREATE OR REPLACE`, verifies the successor and ends
with the owner-only witness refresh. The personal scope floor is checked for the
answering assistant pinned for the operation (`app.v2_assistant_id`, workspace
and placement checked) or the bound assistant. `installation-authentication.mjs`
still verifies 316 functions and checks the parent's exact body and metadata.

The Page-derived title payload admission has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-title-revision-admission.mjs
node packages/api/scripts/conversation-store/build-title-revision-admission.mjs --check
```

It generates `8286_title_revision_admission.sql` from the frozen
`installation-authentication-8281.mjs` recipe (a byte copy that authenticates all
316 predecessor functions and the witness before any mutation),
`title-revision-admission.sql` (the successor body) and
`title-revision-admission.mjs`. The renderer replaces the registry member
`session_context_revision_allowed` only when the predecessor renders its exact
installed body; the reviewed propagation repins every consumer and the migration
ends with the owner-only witness refresh. The successor asks the 8278 Page adapter
after the ordinary capture declines and otherwise keeps the original evaluation;
nothing is stored. `installation-authentication.mjs` still verifies 316 functions,
including the successor body, metadata, two-role ACL and registry record.

The Page-root successor of the Page adapter has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-page-closure-roots.mjs
node packages/api/scripts/conversation-store/build-page-closure-roots.mjs --check
```

It generates `8287_page_closure_roots.sql` from the frozen `installation-authentication-8286.mjs` recipe, `page-closure-roots.sql`
(the successor body of `capture_page_closure_evidence`) and `page-closure-roots.mjs`.
It replaces only the exact 8278 body, after checking its metadata, two-role ACL,
registry record and that no catalog body pins its fingerprint; the member is outside
the propagation templates, so its typed registry record is rewritten directly and
the migration ends with the witness refresh. The successor admits Page receipt roots
and reads the canonical lineage in chunks of 100 roots. `installation-authentication.mjs`
still verifies 316 functions and compiles the member from the successor source.

The fused admission owner has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-fused-admission.mjs
node packages/api/scripts/conversation-store/build-fused-admission.mjs --check
```

It generates `8289_fused_admission.sql` from the frozen `installation-authentication-8287.mjs`
recipe (a byte copy of the 8287 head), `fused-admission.sql` (the jsonb-only type
`fused_node_pre` and the 75 compiled members), `fused-admission-capture.sql` (the wrapper
body of `capture_conversation_evidence`), `fused-admission-pins.json` and `fused-admission.mjs`.
8288 is reserved for another lane. The migration authenticates the 8287 closure, classifies
original pin consumers, installs the members and `capture_conversation_evidence_generic` (the
exact installed predecessor capture body, owner-only, added to the propagation templates with
the capture's parts so every later guard re-render repins it), enrolls the 76 members,
re-renders the guard roster and the capture body through the reviewed propagation, which
repins every consumer, source-authenticates every member and ends with the witness refresh.
The wrapper checks the pinned guard fingerprint first (the predecessor's entry fence, which the
8275 joint preparation owner reads), runs the compiled owner `fused_f_capture` and answers every
shape it does not compile (the route sentinel, or any error outside the availability classes 40, 53, 54, 55,
57, 58 and XX) with the generic owner as one whole capture; nothing is stored. The fused source
was derived from the installed canonical bodies of the 8287 chain by counted substitutions and
anchored cuts and reduced to the compiled path (receipt `m1-fused-admission-adoption.md`);
`fused-admission-pins.json` holds the normalized prosrc digests of the 86 canonical bodies it
reproduces, and the authenticator refuses when one changes, so a successor that changes such a
body must change its compiled form in the same migration. `installation-authentication.mjs`
now verifies 392 functions; the 8287 and 8289 recipes refuse each other's installation. A
later executable-contract migration derives from a frozen copy of this recipe.

The Project participation retirement has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-participation-read-retirement.mjs
node packages/api/scripts/conversation-store/build-participation-read-retirement.mjs --check
```

It generates `8290_participation_read_retirement.sql` from the frozen
`installation-authentication-8289.mjs` recipe (which authenticates all 392 predecessor
functions and the witness before any mutation) and `participation-read-retirement.mjs`,
which derives every predecessor from its immutable migration text (631, 720, 8051) and
checks its sha256. The renderer replaces the two registry members
`read_entity_derivation_source_before_capture` and `native_worklist_source_capture` only
when the predecessor renders the exact 631 body; the reviewed propagation then repins
their registry records and every consumer, and the migration ends with the owner-only
witness refresh. Three ordinary functions (the derived entity and file writers and the
canonical task patch) are rewritten in place after an exact body, metadata, ACL and
no-pin check. No member is added; `installation-authentication.mjs` still verifies 392
functions and checks both successor bodies, metadata and registry records.

The fused admission plan-size successor has its own forward owner:

```sh
node packages/api/scripts/conversation-store/build-fused-admission-tuning.mjs
node packages/api/scripts/conversation-store/build-fused-admission-tuning.mjs --check
```

It generates `8294_fused_admission_plan_size.sql` from the frozen `installation-authentication-8290.mjs`
recipe (a byte copy of the 8290 head) and `fused-admission-tuning.mjs`. The 8289 compiled helpers are
inlinable SQL, so each call site expanded the helper's whole body into the fused statement, and
PostgreSQL initializes every node of a cached generic plan at each execution: the 8289 shared release
spent about half of its backend time in executor start-up and was slower than the generic owner. 8294
refuses unless the 17 largest helpers are the exact 8289 members, gives each the `search_path` its
callers already run with as a function-level setting (which stops inlining; bodies, owner, ACL and
outcomes are unchanged), rewrites their typed registry records directly (nothing pins them) and ends
with the witness refresh. `installation-authentication.mjs` still verifies 392 functions and compiles
the tuned references with the same setting; the 8290 and 8294 recipes refuse each other's installation.

## Verified retained graph adjacency

`8327_conversation_graph_set_verification.sql` authenticates the installed
8326 release before replacing the private `conversation_dag` body and
refreshing its executable witness. Generate or verify the numbered SQL with
`node packages/api/scripts/conversation-store/build-conversation-graph-set.mjs
--candidate PATH` or `--check`.

Each graph evaluation retains the canonical volatile closure reads and
independently observes its complete adjacency again. The second observation
uses typed joins for reviewed native node shapes and the canonical resolver
for every other node. Any disagreement discards the candidate and reruns the
canonical closure and adjacency. The evaluator still applies the same graph
limits, source and privacy checks, deadlines, and before/after materialization
proofs. The migration changes no persistent relation or execution grant.

`8328_conversation_graph_frontier.sql` authenticates 8327 and replaces the
same private graph body. Its first observation expands supported native
frontiers in sets, with canonical edges for supported mixed families. An
independent SQL statement checks every seed and edge. Mixed observations
also require an unchanged snapshot because they call volatile edge readers.
Unknown families, a bound failure, or disagreement rerun the 8327 path.
The graph uses the verified ordinal edges to build the dependency queue and
the source child lists. The evidence entry point sends an exact directly
requested native annotation query observation to the canonical owner. The
compiled evaluator may finish graph setup before declining the annotation
point. Both routes retain the original authorization checks and proof response.

A closed native capture can check its revision roots with one bounded
canonical lineage walk. The empty Page result is usable only at the original
Page check with the same fresh PostgreSQL snapshot. If the snapshot changes,
the graph can refresh the proof once at that check. Each capture pass obtains
its own proof. The graph runs the original revision visibility and lock
checks. A Page result or unusable proof takes the original per-root path.
The portable authenticator pins the unchanged canonical revision routine used
to render these checks. Run
`node packages/api/scripts/conversation-store/build-conversation-frontier.mjs --check`
to verify the numbered SQL.

### Current Memory query candidates

The generic conversation evidence owner prechecks external ancestry for
every live Memory and for the exact retained ID and version selected by
each immutable query domain. Retired rows outside that domain cannot
enter the canonical Memory selection when an external grant changes.
The scan locks the same bounded workspace cohort, projects only scope
metadata and uses the original complete ancestry reader for every
eligible root. The canonical Memory evaluator still qualifies the
historical selection, successors, held rows, current rights and
independent source grants at each consuming boundary.

### Current conversation context cost

The 8332 installer authenticates the prior conversation definitions and
changes the reviewed evidence and lineage routines. It updates the enrolled
fingerprints and refreshes the native witness in the migration transaction.
The portable verifier applies the same reviewed body replacements and checks
the compiled fused routines against their historical inputs. Verify the
numbered SQL with
`node packages/api/scripts/conversation-store/build-conversation-context-cost.mjs --check`.
