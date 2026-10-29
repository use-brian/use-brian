# Chat reply streaming and reload

Brian must deliver a saved, currently authorized reply both on its live stream
and after a browser reload. A database row alone does not establish that the
current reader may see its source-dependent content.

## Streaming under backpressure

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

## Regression coverage

- Burst notifications coalesce under a paused consumer with unchanged text,
  bounded combined chunks, and preserved reasoning/tool/completion order.
- Current source and recipient revocation still blocks the next emitted chunk.
- Reload returns a saved assistant reply with protected native dependencies to
  its authorized reader, and refuses a withdrawn or unrelated reader.
- Admission is checked again after asynchronous response preparation.
- Missing query floors fail closed without exposing content or crashing title
  projections, and failed browser history fetches reject.
