# Provenance lookup schema contract

The authenticated provenance lookup probes supported primitives through the
ordinary RLS connection. A missing or inaccessible row returns no result; a
schema mismatch in a later probe must not turn that outcome into a server error.

`entity_links` stores creation time and source Episode but has no
`created_by_user_id` or `created_by_assistant_id` columns. Its probe projects
typed nulls for those fields and retains the existing unknown-author response
(`created_by_user_id: ''`, `created_by_assistant_id: null`). Visibility ownership
and verification are not evidence of authorship. Other primitives continue to
return their actual author columns. Episode access checks and silent omission
of inaccessible sources remain unchanged.

Every primitive, predecessor and Episode probe also applies the universal read
predicate from the supplied retrieval actor, independently of ambient execution
context. This preserves workspace, private and assistant partitions, clearance,
Department and Project bounds on both the requested row and returned references.
The document-specific entity-instance probe retains its placement RLS and binds
the requested workspace explicitly.
