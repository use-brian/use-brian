# Native Memory writes after index reads

Native Memory indexes carry immutable `application_field` observations of an exact query domain: selected fields, caller visibility/bounds, candidates, and policies. The turn retains that evidence when saving a Memory. It must not discard the index source, upgrade to an owner connection, or treat successful model-input admission as permission to skip durable-write checks.

## A query must not invalidate its own output

Previously, the new Memory row changed the index's candidate cohort before `record_admitted_application_field_derivation` could record its lineage. The source-reference trigger and final validation consequently rejected an otherwise current write with `scope_source_changed`. Retrying the same conversation could reproduce the same failure.

Migration `8326_native_memory_query_write_contract.sql` composes the original
8268 Memory fix with the current canonical conversation installation. Both
historical query readers exclude new Memory outputs explicitly derived from
the exact query domain. Original candidates retain their exact version and
policy checks. Unrelated growth, changed or held inputs, policy changes and
revoked authority still cause refusal. Fresh queries include saved outputs
normally. A different field selection creates a different query domain.

The exclusion follows the derived output's resource identity, not just its first version: later versions of an output do not retroactively become inputs to the historical query. This never suppresses version or policy checks for IDs in the query's original candidate set, nor the output's own current-source checks.

## Atomic publication

The existing non-owner lineage port keeps its actor, workspace, new-row transaction identity, output ownership, mutation, label, duplicate-input, exact-version, retention, and dependency checks.

After its output guards, the port:

1. Creates the tentative derivation header.
2. Stages exact native Memory query selectors in `native_memory_query_write_intents`, which has RLS and no PUBLIC or app-role grants.
3. Inserts the real source edges. The selectors bridge the immediate source-reference trigger before its own edge is visible.
4. Deletes the selectors before final source validation.
5. Performs the existing exact source and ancestry checks. Any failure rolls back the statement; the retained host transaction rolls back the Memory row as well.

Selectors are usable only in their creating transaction. After publication, only canonical immutable lineage edges justify historical exclusion. There is no caller-supplied admission flag, GUC, reusable receipt, or new execution port.

The normal installer authenticates the 8325 predecessor. It preserves
function metadata and grants, updates the two enrolled reader entries and
refreshes the native contract witness. Previously applied 8268 is retained
in the historical ledger. The installer preserves already written Memory
values and immutable observations. Portable restore carries the durable
source edges. The intent table is installation-local and must be empty in a
committed snapshot.

## Regression coverage

The private-transcript integration suite exercises populated and empty indexes, immediate constraints, repeated writes in the same turn, final reply publication, fresh-index visibility, independent source changes, credential withdrawal, cross-projection separation, selector permissions/cleanup, and rollback after late SQL rejection. The Memory tool suite also verifies explicit learning after a ranked-index read.

Run DB-backed suites only through the owned disposable PostgreSQL fixture in `scripts/crm/local-fixture.mjs`; never use live conversations or saved Memories as fixtures.
