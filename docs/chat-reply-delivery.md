# Chat reply streaming and reload

Brian must deliver a saved, currently authorized reply both on its live stream
and after a browser reload. A database row alone does not establish that the
current reader may see its source-dependent content.

## Trivial conversation overhead

Exact short greetings, acknowledgments and connectivity probes (`test`, `ping`,
`pong`) use a conservative allowlist. Substantive requests such as `test my API`
or `compare prices` still use the normal model paths, regardless of length.
Research assessment skips its provider on these messages. Topic classification
can continue the last admitted topic with zero confidence when no explicit
reply target needs interpretation. All original input and final authority checks
still apply to deterministic results.

Automatic title generation leaves the placeholder in place while every admitted
user message is trivial; the first substantive turn can generate a meaningful
title normally. The state-diff model is skipped only when there are no open
commitments and every supplied user/assistant turn is plain trivial text. An open
commitment, tool block, substantive answer or non-text content keeps the diff
pass, so an acknowledgment can still resolve an existing commitment.

## Streaming under backpressure

### Latency diagnostics

The `turn_timings` event and `[chat] turn timings` line include request-relative
milestones (`*_at_ms`) for loop start, first delivered reasoning, first delivered
text, generation completion, reply publication, loop return and client completion. A missing milestone
means it was not reached. Repeated deltas never overwrite the first timestamp.
Counters separately time research and topic classification, history reads,
compaction, reply publication, session-state diff and title generation. These
counters overlap the enclosing phases and must not be added to the phase totals.
In particular, the existing `loop_ms` can include awaited post-loop state work;
use the publication and loop-return milestones to identify that tail.

Each existing `[stream]` summary also reports first chunk/reasoning/text arrival,
chunk counts, and time waiting for the inner iterator versus time suspended at
`yield` for its consumer. Inner-iterator time includes provider setup, authority
checks and network waits; it is not a measurement of remote inference alone.
Consumer time includes delivery authorization and backpressure. First-arrival
times are stream-relative and can include earlier consumer waits. Summaries are
emitted on completion, errors and cancellation, use monotonic clocks, and contain
only counts, durations and a registry model alias (`other` for custom models).
They never log prompts, replies, reasoning, tool arguments or endpoint URLs.

The Codex transport receives notifications independently of the query-loop
consumer. When authorization or delivery is slower than incoming notifications,
combine adjacent queued text deltas of the same kind, up to 4,096 JavaScript
characters per combined delta. Apply this to text and reasoning separately.
Do not add a batching timer, merge across a tool/usage/error boundary, mutate
an already yielded chunk, or alter the final text. Individually larger provider
deltas retain their original size. Tool arguments and lifecycle events keep
their existing order and identity.

Every combined chunk still crosses the existing current source and recipient
authorization checks. There is no permission cache, TTL, or revocation bypass.
This reduces work from one expensive authorization round per provider token to
one round per bounded queued chunk when the consumer is behind.
Coalescing reduces repeated checks under backpressure; it does not shorten an
individual permission check or the provider's own inference time.

## Authenticated transcript reads

The browser history endpoint must resolve the verified native caller's current
read-only session authority and read the canonical admitted history, including
its immutable source dependencies and topic annotations. It must revalidate
the captured evidence at the actual JSON response boundary, after profile
lookups. Never fall back to an owner-pool history read or use source IDs supplied
by the browser as authority. Keep the existing session and anchor access gates.

A null native query floor means admission was lost: normalize it to a scope
refusal, rather than throwing a JSON schema error that poisons the session list.
The chat surface uses strict SDK history reads: transient failures reject and
must not masquerade as a successful empty transcript and erase visible messages.
Authoritative 401/403/404 responses evict the transcript cache and painted rows;
previously readable content must not remain visible after access is withdrawn.

Session lookups inside source and recipient authorization are read-only. They
must not refresh session recency while another authorization transaction holds
that session's row lock. Ordinary UI recency updates skip a currently locked
row; this never changes turn heartbeat or publication guarantees. See
the contention contract below.

## Database contention

Native transcript publication may reuse the complete private Memory evaluation
frame within its own SQL statement, under the original publication locks. Only
a fully admitted frame for the original source tuple can seed the evaluator's
worklist. Original native points use the exact current scopes admitted by that
complete private frame; a missing point still invokes its canonical reader.
Field evaluations, retained-source comparisons, mutation grants and output
scope checks still run. Unsupported or incomplete cohorts use
the canonical evaluator. The private worklist is never accepted from an app or
exposed to callers, and is rebuilt for every statement, including a later write
in the same transaction. Regression coverage profiles a query-backed publication
and verifies that a changed source is refused by the next statement.
The transcript dependency trigger can also use the exact current field scopes
from a new private frame obtained during that trigger invocation. It retains
the canonical field reader for unsupported roots or a changed reader contract.
The original retained-edge, privacy, output-label and external-source checks
still execute for every row; no proof is shared between trigger invocations.

The 2026-10-29 home-server incident included a deadlock between a workspace
picker update and session-history admission. Increasing the API pools to 16
removed checkout timeouts after the 23:33 HKT restart, but 49 SQL statement
timeouts remained. Pool capacity and conflicting row locks are separate limits.

Migration `8142_workspace_navigation_policy_revision.sql` excludes picker-only
membership updates from the older workspace access-policy revision trigger.
Compare every old/new column except `picker_pinned_at`, `picker_hidden_at` and
`picker_last_opened_at`, so present and future authority fields stay protected.
Inserts, deletes and all other membership changes retain their workspace lock,
revision and notification protocol. The application-policy epoch trigger
already excludes personal navigation changes.

Recency is best effort: select the session row with `FOR NO KEY UPDATE SKIP
LOCKED` before updating `last_active_at`. A busy row must remain readable.
Authorization uses `readSessionById`, which performs no recency write. This
never skips turn ownership, heartbeat, cancellation, publication or scope writes.

Historical-label projection identifies immutable non-history selectors in one
metadata read. Do not recursively admit every ordinary field merely to
determine that its selector is not Memory history. Skip these probes only for
positively identified ordinary selectors. Unknown resources, including metadata
not yet committed by the current transaction, retain the original RPC on that
transaction. Every history root still receives its current SQL proof on the
exact supplied tuple; all ordinary fields keep their full existing validation.
Repeat classification and authorization at the final footprint check. Metadata
discovery grants no permission, and no authorization result is cached between calls.

## Regression coverage

- Burst notifications coalesce under a paused consumer with unchanged text,
  bounded combined chunks, and preserved reasoning/tool/completion order.
- Current source and recipient revocation still blocks the next emitted chunk.
- Reload returns a saved assistant reply with protected native dependencies to
  its authorized reader, and refuses a withdrawn or unrelated reader.
- Admission is checked again after asynchronous response preparation.
- Missing query floors fail closed without exposing content or crashing title
  projections, and failed browser history fetches reject.
