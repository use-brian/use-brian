# Retained native reader source

These reviewed SQL templates generate the immutable forward migration
`8267_retained_native_graph.sql`:

```sh
node packages/api/scripts/retained-native-reader/build.mjs
node packages/api/scripts/retained-native-reader/build.mjs --check
```

After release, change behavior through a new forward migration. Do not regenerate
applied SQL. CI checks that this migration remains equal to these source inputs.

`indexed-edges.sql` compiles the canonical semantic and versionless privacy
relations into one private node dictionary and integer adjacency. The exact
canonical predecessor code, owners, complete portable metadata and ACLs are
authenticated before installation. The original guard's 149-member roster uses
the target collation; the publication contract uses independently validated local
catalog bindings. Their checksum-bound historical templates authenticate every
other byte before either guard executes. Both original edge readers remain in
the retained contract. A
canonical rule change requires an explicitly reviewed compiled successor.
Candidate rows, absent heads, immutable versions and edge kinds are never pruned.

`metadata.sql` discovers complete requirements before protected payload reads.
`capture.sql` and `cohorts.sql` use the original dependency-ordered canonical
reducers with fresh private state. `reservation.sql` overlays only the exact
staged canonical observations. `query.sql` runs independent acquisition after
materialization in a separate Read Committed command and compares all original
floors, payloads, candidates, current sources and directed relationships.

`query-cache.mjs` checksum-extracts four unchanged canonical reducers from 8199
and generates private adapters for historical query-domain scans. A completed
canonical-mask point computes its original query envelope once; only then does
its exact key receive a private array slot. A completed SQL NULL remains distinct
from an absent slot. Unsorted points retain their original identity and never
stand in for an uncompleted canonical-mask peer. Scans retain every physical
candidate, original attempt bound, scope/visibility predicate and ordered tuple.
Read/identity/Memory reducers and final selector scans remain canonical. Every
acquisition, including the fresh post-write command, starts with empty slots.
The four canonical predecessors are authenticated by exact body and complete
portable executable metadata before installation and full catalog pins at runtime.
The private query-domain adapter expands each child's direct and declared source
array with the original concatenation rule, then applies the same exact distinct
and text ordering in one aggregation. It avoids repeatedly copying accumulated
source arrays; source tuples, versions, limits and digest inputs remain unchanged.

The contract registry contains executable catalog expectations, not permission
receipts. Application callers receive only identity-based facades. Original
dispatchers authenticate the new guard's catalog identity before executing its
complete contract, and repeat both checks before accepting its result. No graph
or completed allow state crosses an invocation boundary.

Regression coverage lives in the `retained-conversation` acceptance suite and the
separate recovered Calendar/Telegram suite. Their ordinary SQL deadlines remain
15 seconds. A fictional Telegram transport checks the actual production adapter
and acknowledgement/recording order; it does not certify a live deployment.
