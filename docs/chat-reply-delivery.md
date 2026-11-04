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

Coalescing reduces work when the consumer is behind. It does not shorten the
provider's inference time. The authorization path depends on the response type,
as described below.

## Response delivery snapshots

Native authenticated web chats use one request permission context. It owns the
selected execution permissions and derives delivery receipts from that same
selection; there is no independent delivery permission loader or subscription.
Its methods separate action selection (`beforeAction`) from destination/source
admission (`authorizeDelivery`). Resolve user and assistant access before reading
context. For shared web rooms, also
intersect the stored room clearance, Department labels and Project scope before
constructing prompt and tool authority. Exclude user-private rows. Shared Project
rooms retain their additional Department exclusion. Office file conversations
keep their file ceiling; provider groups keep their separate approved audience.

On the first native output, admit the source evidence against the pinned
recipient limit. Subsequent text or reasoning events with the same evidence
reuse that response's admission. They do not resolve the destination again or
resubmit all accumulated sources. When a tool adds an observation, admit only
the new source observations and the complete accumulated label floor before
releasing its output. A changed source version is a new observation.

A delivery receipt belongs to one selected execution, accumulator, destination
and permission ceiling. A new action selection discards old cached receipts,
without changing completed results or the executions held by in-flight actions.
Those older executions must receive fresh delivery admission before reusing a
receipt. Cancellation, replacement of bindings, or failed delivery admission
refuses output. A delivery failure stays invalid for the request. The kernel
checks runtime ownership; a copied owner or custom callback cannot opt in.

Independent connector ancestry, unsupported source families, non-native callers,
Office/feed anchors and non-web destinations keep the existing live delivery
protocol. Native fields that reveal independent ancestry also switch permanently
to that protocol for the response. A cached native admission is never external
source delivery consent.

This is a delivery optimization, not a database permission freeze. Model input,
tool execution, authentication and authority leases still use their existing
checks. Source holds, retention and canonical publication/write-lineage checks
remain in place. A live permission change can still stop the current response.
Full next-response-only permission semantics requires a separate database
read-admission design; the JavaScript execution snapshot alone cannot provide it.
The [request permission context](action-permission-snapshots.md) owns lazy event
invalidation and the trusted-resolver adapter. Native chat delivery now uses that
shared owner. Automatic action-start execution switching is still pending and
does not change the live-input, writer or database guarantees above.

## Authenticated transcript reads

### Attachments before the first message

A native personal Chat upload that creates its staging session must use
`createPersonalWebSession`, with the actor, authentication session and auth
version taken from verified request claims. Use the resolved assistant's
workspace and the selected Team/Project context. Never manufacture the personal
session admission receipt through the legacy session upsert or accept auth
claims from multipart fields. Missing authentication claims refuse the upload
before parsing or caching the file. Existing-session uploads retain their
current session-read gate and do not create another session.

The 2026-11-04 attachment failure was a staging-session insert refused by
`personal_session_admission_required`, before PDF parsing began.

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
- Native web output admits unchanged evidence once; new tool evidence is checked
  before release, without resubmitting the previously admitted sources.
- Shared web room input authority cannot exceed the stored audience.
- Snapshot identity, cancellation, sticky failures and live execution revocation
  remain enforced; independent sources retain per-event delivery admission.
- Current source and recipient revocation still blocks the next emitted chunk
  on the existing live-delivery paths.
- Reload returns a saved assistant reply with protected native dependencies to
  its authorized reader, and refuses a withdrawn or unrelated reader.
- Admission is checked again after asynchronous response preparation.
- Missing query floors fail closed without exposing content or crashing title
  projections, and failed browser history fetches reject.

## Telegram legacy null `sessions.workspace_id`

Native channel turns admit history through `session_context_parent_snapshot` /
`application_session_query_parent`, which select
`FROM sessions WHERE workspace_id = <assistant workspace> AND id = <session>`.
A personal Telegram DM created before workspace denormalization can still have
`sessions.workspace_id IS NULL` while its assistant is workspace-bound. Inbound
user messages may persist (turn scope supplies `workspace_id`), then
`readAttendedSessionHistory` fails with `DerivedScopeError: scope_source_changed`
and Telegram returns the generic retry notice.

Code fix: personal `findOrCreateSession` ON CONFLICT resume fills a NULL
`workspace_id` from the proposed assistant workspace, and the channel/chat
native transcript gates refuse a projected null session workspace.

### Prod unblock before deploy (home-server Brian)

One-row patch for the known broken DM (`29b60ae5-…`, assistant `736d322d-…`,
workspace `2c9d5a3c-…`). Run against the Brian DB as an operator with write
access; do not broaden to a mass update without review:

```sql
UPDATE sessions s
SET workspace_id = a.workspace_id
FROM assistants a
WHERE s.id = '29b60ae5-cb39-41b8-a4a1-eeab4268f502'
  AND a.id = s.assistant_id
  AND s.workspace_id IS NULL
  AND a.workspace_id = '2c9d5a3c-cea4-4439-baee-24934c1fb2ac'
RETURNING s.id, s.workspace_id;
```

Legacy unscoped message rows (null `session_messages.workspace_id`) stay
unscoped and drop out of native history scans; already-scoped turns remain.
Web session-recovery intentionally leaves null-workspace personal web rows
untouched and mints a new chat — Telegram personal identity is unique, so
resume must backfill rather than mint a second DM row.
