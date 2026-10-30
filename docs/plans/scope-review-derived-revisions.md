# Scope review of derived revisions

Administrator classification freezes the complete bounded canonical descendant
graph before moving a live source into a department. Selectable roots and
dependent resources have separate registries: immutable dependent revisions can
be held without becoming selectable roots.

Session context revisions and Knowledge entry revisions are dependent resources.
Review captures only their kind, ID, immutable scope version and effective held
state. It locks metadata in the same workspace-first transaction as the root,
includes those references in the immutable payload hash, and rechecks them before
apply. Protected content is never fetched to build impact evidence. The SQL
impact guard independently validates the same references. Missing rows without
verified removal evidence, unknown kinds, changed versions and changed dependencies refuse review; they are never
silently omitted or converted into empty impact.

The canonical source update still performs invalidation. This extension does not
relabel dependent revisions, release holds, widen permissions, rewrite historical
versions or certify full migration. Private, assistant, sensitivity and Project
restrictions remain unchanged.

Every review transaction binds its authenticated human actor locally before SQL
readers run. A pooled connection whose previous local user setting reset to an
empty string must not break inventory. Retired and retracted roots remain
inspectable but cannot be offered as classifiable live records.

Migration 8143 adds an owner-only metadata reference reader for these two revision
families and uses it in the immutable impact guard. It grants no application role
access to revision metadata or review mutation. Regression tests cover derived
revisions, stale holds, immutable references, tenant separation, unsupported
descendants and the actual non-owner application role.

Inventory regression fixtures use legacy metadata without fabricating protected
compact-summary content. Changes to a lock timestamp exercise fingerprint
reconciliation; legacy owner visibility is asserted using its current canonical
`personal` value.

Remaining migration work includes explicit session/connector/job authority
migration, dependent cache regeneration, protected-history exclusions, and full
inventory/intake certification. Finalization stays blocked until implemented.

## Removed transcript dependencies

Deleting a session message can leave its canonical derivation receipts in the
descendant graph. Migration 8144 permits a metadata-only removed reference for
this family when the message ID is physically absent across all workspaces and
at least one retained output receipt belongs to the reviewed workspace. Existing
messages with unreadable or mismatched workspace metadata still refuse review.
Other missing families and missing messages without a receipt still refuse.

The owner-only impact reader locks up to 500 retained receipts and fingerprints
their complete metadata, including all output versions, in deterministic ID
order and UTC regardless of the pooled connection's time zone. The impact reference carries `removed: true`, an opaque
`removed:<sha256>` version and `held: true` to represent unavailable history.
It is included in the saved payload hash and independently checked by the SQL
guard. Apply recaptures it; restoring a message or changing its retained evidence
invalidates the preview. Old references are never silently converted to removed
references. Canonical writers take the workspace lock before publication, which
serializes them with the workspace-first review transaction.

Removed references are evidence, not selectable roots or classification targets.
No message is restored, relabelled or released. Canonical invalidation continues
through retained graph nodes and holds existing downstream resources. Tests use
actual derived messages and deletion in a disposable fixture, checking both
memory and file roots, stale restoration, forged references, foreign workspace
records, absent receipts and non-owner application-role access.

Regression coverage also checks the SQL guard directly: omitting or falsifying
the removal marker, changing its fingerprint/held state, adding unknown fields,
or labelling a live message as removed must fail independently of the API. A
preview made before deletion must not acquire removal evidence during apply.

| Migration | Schema change |
| --- | --- |
| `8143_scope_review_derived_revisions.sql` | Owner-only revision metadata reader and independent review-impact guard. |
| `8144_scope_review_removed_messages.sql` | Extends that reader and guard with bounded, fingerprinted removal evidence for absent session messages; no table or grant changes. |
