# Reviewed legacy cleanup

Workspace owners need to remove obsolete General content without resetting their
workspace or deleting records already filed into departments. A legacy marker is
not itself permission to delete an assistant, provider credential or scoped data.

## Contract

The owner-only workspace cleanup API previews at most 25 explicit selections and
saves immutable metadata evidence, a payload hash and a fifteen-minute expiry.
Apply checks the same owner, workspace, policy, source versions, dependencies and
retained-record fingerprints. A completed receipt replays without another write.
The API uses normal authenticated workspace routes; app roles receive no direct
cleanup-table privileges. Cleanup never certifies strict mode or completes the
workspace migration by changing a flag.

An erase selection may name a General source or impact from the existing closed
scope registry, an unbound conversation, or a legacy workflow/goal with missing
authoring authority. Named department resources are retained. Running sessions
and pending, running or waiting workflow runs refuse cleanup. Assistant identities, members, provider
credentials and department/project access memberships are never erased here.
Immutable evidence guards and foreign-key restrictions still apply.

Preview simulates the exact deletes in a savepoint and rolls them back. It
compares complete database-side fingerprints of retained department records,
including scope/hold state and content, without projecting their content. Apply
repeats this check in its transaction. If a delete would remove, rewrite or hold
a retained record, the transaction refuses. Canonical descendants are frozen and
unknown or unverifiable dependency kinds refuse. Deleting old history therefore
cannot silently invalidate the Personal data the owner elected to retain.
Database foreign-key reach is checked as well as canonical derivation reach;
cross-workspace references, department-labelled cascade children, unsupported
schemas and unbounded/deep dependency walks refuse cleanup. Immutable context
and Knowledge revision data and required file/recording payloads are included in
retention. Unknown canonical compartment metadata is protected rather than
treated as General. At most 500 protected/dependent references are supported.

Legacy assistant bindings can instead be confirmed against their active home
department. This operation preserves the existing unlimited legacy audience and
Project settings, writes an explicit default department, and records reviewed
binding provenance. It supports only a legacy binding with unrestricted legacy
compartments; finite/unknown legacy audiences refuse rather than being widened.
Normal binding readiness checks still apply. No membership is recreated and no
clearance is changed.

Every erased scope resource leaves a content-free cleanup receipt. The ordinary
impact reader recognizes a physically absent resource only through that applied
receipt, so a reviewed deletion does not leave unreviewable descendant edges.
Such evidence is frozen as removed/unavailable and cannot authorize source reads,
release holds, restore content or relabel immutable historical snapshots.

Failures identify a bounded metadata blocker. An unsupported erasure is never
replaced with an unchecked SQL cleanup, a fake General confirmation or a force
release. Complete cleanup requires a fresh inventory after all reviewed batches.

## Schema and verification

Migration 8145 adds owner-host cleanup review storage with immutable proposals and
owner-only erased-resource reference reading. No content table, runtime grants or
existing migration is rewritten. Tests use a disposable PostgreSQL fixture with
real canonical source writes, deletion invalidation and application-role denial.
They cover authorization, tenant boundaries, scoped-record retention, stale
content/evidence, cancellation/replay, unknown dependencies, and assistant
binding conversion without changes to grants or clearance.
