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
impact guard independently validates the same references. Missing rows, unknown
kinds, changed versions and changed dependencies refuse review; they are never
silently omitted or converted into empty impact.

The canonical source update still performs invalidation. This extension does not
relabel dependent revisions, release holds, widen permissions, rewrite historical
versions or certify full migration. Private, assistant, sensitivity and Project
restrictions remain unchanged.

Migration 8143 adds an owner-only metadata reference reader for these two revision
families and uses it in the immutable impact guard. It grants no application role
access to revision metadata or review mutation. Regression tests cover derived
revisions, stale holds, immutable references, tenant separation, unsupported
descendants and the actual non-owner application role.

Remaining migration work includes explicit session/connector/job authority
migration, dependent cache regeneration, protected-history exclusions, and full
inventory/intake certification. Finalization stays blocked until implemented.
