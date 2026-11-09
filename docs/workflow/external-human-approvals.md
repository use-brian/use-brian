# External human approvals

External approvals are display-only, one-time decisions. They never execute a Brian tool or resume a workflow. In product UX they behave like tool-use confirmation requests (Allow/Deny cards in chat or channel actions), not a separate Approvals decision queue. A separate relay consumes the decision and acknowledges its own attempt; an approval, notification, or receipt is not proof of tool execution.

The [confirmation consolidation plan](approval-confirmation-merge-plan.md) records
how this feature reuses the existing tool-request UI without changing native
workflow/tool execution. The legacy Approvals panel is not an external decision
surface; existing native-kind review flows remain compatible.

## Workspace setup

A workspace owner or administrator opens **Workspace settings > External approvals**:

1. Choose a name and assistant, then explicitly select a connected conversation, including an accessible web chat. There is no approver picker or recent-message-history dependency.
2. Register the application and copy the one-time credential into its approved secret storage. Only its SHA-256 digest and display prefix are persisted.
3. Configure the relay endpoints below. No server allowlist or restart is required.

The administrator needs current assistant and selected-conversation access. The selected conversation defines the audience, not a named approver: a deciding human must be a currently authenticated workspace member with current canonical assistant and selected-conversation access. Registration grants no new authority.

Discovery lists available destinations and installed connections with unavailable reasons; installing a connection does not promise delivery. `no_conversation` means no eligible accessible conversation for that connection; `unsupported_transport` identifies an unsupported transport. Discord is unsupported. WhatsApp Cloud API is unavailable for pinned approval delivery, identified using public integration metadata; connector-backed WhatsApp requires a compatible address. Web remains a special session-bound surface, not a proactive transport.

The source list exposes public metadata and revocation state. Rotation invalidates the old bearer without changing the immutable binding or human evidence. Revocation disables further ingestion, polling, decisions and unconsumed receipts, but cannot undo actions already taken. To change the assistant or destination, revoke and register again. Legacy person-bound registrations remain compatible.

Credentials live only in the one-time response and the mounted reveal component, never in the surface cache or browser storage. Switching workspace/viewer or closing the screen discards the reveal. On an ambiguous network failure, refresh the source list before retrying; if issuance succeeded but its response was lost, rotate that source to obtain a new credential. Do not automatically replay credential mutations.

Messaging delivery uses confirmation-style Allow/Deny actions or deterministic `approve`/`reject` replies. Web delivery is a no-op push: the selected session restores **all** applicable concurrent requests through `externalConfirmations` from `GET /api/sessions/:sessionId/pending`. Use the existing `ChatConfirmationCard` and Chat's **Needs you** surface only, not a separate queue. Cards show the full frozen literal request, independently of live tool confirmations and their private turn leases. A notification failure is not evidence of delivery or consent.

### Workspace management API

These endpoints require ordinary Brian user authentication, not the source bearer. They are owner/admin-only and are not exposed as model/MCP tools. Mutations additionally require a live authenticated human session; the session ledger, current administrator role, current membership, canonical assistant/selected-conversation access and destination routing are revalidated in the write transaction.

Base: `/api/workspaces/:workspaceId/external-approval-sources`.

- `GET /`: `{sources:[...]}` containing public metadata only, never a digest or bearer.
- `GET /destinations?assistantId=uuid`: returns `{destinations,connections}` with opaque destination IDs and connection availability/reasons. Requires a live authenticated human session; select an offered ID rather than constructing one.
- `POST /`: strict `{name,assistantId,destinationId}`; returns HTTP 201 `{source,token}` once. Legacy `{name,assistantId,approverUserId,notification:'web'|'verified_channel'}` remains supported, with notification defaulting to `web`.
- `POST /:sourceId/rotate`: exactly `{}`; returns `{source,token}` once.
- `DELETE /:sourceId`: revokes the registration; returns HTTP 204.

Issuance responses use `Cache-Control: no-store`. Authority identifiers and source IDs are server-bound, not incoming request metadata. Registry reads are live and approval transactions lock and revalidate the current registration, so stale snapshots cannot survive rotation or revocation. Source bindings cannot be edited or revived. Creation, last rotation and revocation retain actor/timestamp metadata. Removing an assistant/member makes the source inapplicable; it does not block their deletion. Workspace erasure removes its credential metadata.

### Database rollout

Migrations `8241_external_human_approvals.sql`, `8242_workspace_external_approval_sources.sql`, `8243_external_approval_web_chat_destination.sql` and additive `8244_external_approval_conversation_members.sql` describe the schema. Migration 8244 permits nullable approvers only for external approvals; native approvals still require a named approver. It adds `audience: conversation_members`, `destination_session_id` and `thread_ref` without rewriting legacy sources or hashes.

The immutable binding freezes the selected session, integration and exact Slack/Feishu thread, and requires the pinned assistant to remain the winning route. Unthreaded and threaded conversations are distinct; neither can authorize the other. Only conversation-member `sourceBinding` adds the `conversation_members:v1` version and session/thread fields; legacy source-binding and payload hashes remain unchanged.

Transport and credential sidecars remain owner/service-only under RLS. A narrow boolean RLS helper allows applicable pending-row reads without exposing sidecars or credentials. Owner-pool writes revalidate authority; do not disable RLS or grant tenant sidecar access. Earlier migration filename aliases remain compatible; never rewrite the ledger to replay DDL. No deployment, migration application or credential provisioning was performed for this documentation update.

## Authenticated relay contract

All endpoints require `Authorization: Bearer <source bearer>` and return lifecycle state plus the literal answer for an applicable answered question. They are mounted before user authentication at `/internal/external-approvals`, not under `/api`.

- `POST /internal/external-approvals`: `{externalRequestId, taskId, sessionId, request, expiresAt}`.
- `GET /internal/external-approvals/:externalRequestId`: poll current applicable state.
- `POST /internal/external-approvals/:externalRequestId/ack`: `{status:'applied'|'stale'|'failed'}`.
- `POST /internal/external-approvals/:externalRequestId/cancel`: exactly `{}`.

For approvals, `request` is `{method:'confirm',title,message?}` or `{method:'select',title,message?,options:['Allow once','Deny']}`. The additive `question` method is described below. No extra fields, executable callbacks, tools, transport data, identity or destination are accepted. No strings are truncated. Title is bounded to 16,384 characters, message to 32,768; correlation IDs to 200. External request IDs contain only ASCII letters, numbers, `_`, `.`, `:`, `-`. Other text rejects control characters except newline, tab and carriage return. `expiresAt` must be an ISO date-time with timezone and initially in the future. Effective expiry is the earlier of incoming expiry and initial ingestion + five minutes; retries never extend it.

All responses have `{approvalId,externalRequestId,status,expiresAt,payloadHash,ackStatus?}`; answered questions additionally return `answer`. Status is `pending|answered|approved|rejected|expired|superseded`. Missing/invalid bearer is 401; invalid input 400; unavailable/foreign/revoked source 404; immutable replay conflict or conflicting acknowledgement 409. Replays return the same approval, hash and effective expiry without creating a new notification.

### Payload hash

SHA-256 lowercase hex of UTF-8 `JSON.stringify` of the normalized object in this exact field order:

```
{externalRequestId, taskId, sessionId, request, expiresAt}
```

`request` is reconstructed in order `method,title,message?,options?`; optional fields absent from the input are omitted. The hash uses the **incoming expiry normalized with `new Date(expiresAt).toISOString()`**, not the capped effective expiry. Full immutable input, including the display snapshot, participates in the hash. The relay must separately validate effective expiry, task/session/request identity, immutable snapshot and its own pending callback before applying a decision.

### Decision and receipt semantics

A currently authenticated, authorized workspace member may resolve a conversation-member request through `/api/approvals/:id/respond` (`approved|rejected`), including restored cards and Needs you actions. Legacy sources still require their designated human. Channel `approve <id-prefix>` / `reject <id-prefix>` commands additionally require a live linked identity and the exact frozen session/channel, integration and thread. Ambiguous or unavailable prefixes are consumed without invoking a model. Web-only sources cannot grant channel consent.

Authority is checked in the same owner database transaction as the decision, using the live auth session or channel-linked identity, current canonical assistant/conversation access, and canonical workspace policy-epoch locking. Source bearers never authorize public decisions. Models, delegation, learned patterns, standing grants, permanent approvals and generic `PendingApprovalsStore.respond` cannot decide external requests. Consent is human-only and one-time; native approval semantics are unchanged.

Insertion is transactional and source-key serialized. Every decision locks the native pending row, verifies current source authority and checks the database clock in its final write. Only one approve/reject wins. Expired pending requests become expired. A recorded human decision is never rewritten merely because its expiry elapses: polling projects unacknowledged elapsed decisions as `expired`, and an `applied` receipt is then refused. An existing receipt remains historical, not a renewed grant.

Receipts are separate from human decisions. Both approval and denial can be acknowledged `applied`; `stale`/`failed` record relay outcomes. Receipt replay is idempotent; changing a recorded receipt is a conflict. No acknowledgement can grant permission. Cancellation invalidates pending or unacknowledged approved requests as `superseded`; sidecar `superseded_at` preserves an existing human approval and its timestamp as audit evidence. It does not supersede an already acknowledged applied decision. The relay must still close its local pending callback atomically before sending cancellation: Brian cannot retract an action the relay has already executed.

## External questions (additive)

`request` also accepts strict `{method:'question',title,message?,options?:string[],allowCustom?:boolean}`. Without options this is a text question (`allowCustom:false` is invalid); with options it is closed single-choice unless `allowCustom:true`. Options must be 1–20 unique, non-whitespace-only strings, each at most 2,048 characters. An answer must be 1–32,768 characters and not whitespace-only; closed choices require an exact option match. Valid leading/trailing whitespace is literal evidence: never trim or truncate options or answers. The existing control-character restrictions apply. Legacy `select` with `['Allow once','Deny']` remains an approval, not a question. For hashing, question request fields are ordered `method,title,message?,options?,allowCustom?`, omitting absent fields; existing hashes are unchanged.

An authenticated browser human submits `POST /api/approvals/:id/respond` with strict `{answer:string}`, not a decision. Source bearers cannot answer. Channel humans use `answer <id8> <literal answer>`: remove exactly one separator after the eight-character ID, preserving the rest of the answer. Require the exact linked provider sender and frozen selected conversation, integration and thread, plus current membership and assistant/conversation access, under the same transactional authority checks as approvals. Questions carry literal-answer instructions and a Chat link, not Allow/Deny buttons, native workflow-question tokens or the native question store; this avoids provider callback payload limits.

Poll the same source lifecycle endpoint: applicable question responses expose `status:'answered'` and `answer`. Internally the native pending kind stays `external_action`; internal `approved` maps to `answered` only for questions. Expired or superseded responses never return the answer, even though it remains private evidence. Receipt and cancellation semantics and the maximum five-minute TTL are unchanged. An answer never resumes a native tool or workflow.

The shared `ChatConfirmationCard` actions slot renders text, select or custom-answer inputs with a Submit form in both Chat and Needs you. External arrays remain independent and concurrent without blocking the composer. Mounted drafts survive transient errors for retry; expiry, lost races and current permission checks still gate submission and refresh.

Migration `8245_external_human_question_answers.sql` adds `human_answer` to the same private sidecar. It requires an ordinary reviewed migration after the code update; it is not evidence of a live applied migration, tested rollout or deployment.

Example ingestion (existing `TOKEN` and `REQUEST_ID`; generic `BASE_URL`, task/session correlation IDs):

```sh
EXPIRES_AT=$(node -e 'process.stdout.write(new Date(Date.now()+240000).toISOString())')
curl -sS "$BASE_URL/internal/external-approvals" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data "{\"externalRequestId\":\"$REQUEST_ID\",\"taskId\":\"task-1\",\"sessionId\":\"session-1\",\"request\":{\"method\":\"question\",\"title\":\"Which option?\",\"options\":[\"First\",\"Second\"],\"allowCustom\":true},\"expiresAt\":\"$EXPIRES_AT\"}"
```

## Focused verification

From `packages/api`, with existing dependencies:

```sh
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/vitest run src/external-approvals/__tests__ src/routes/__tests__/sessions-questions.test.ts src/workflow/__tests__/approval-replies.test.ts src/workflow/__tests__/approval-deliveries.test.ts src/workflow/__tests__/recent-approval-channel.test.ts src/routes/__tests__/approvals.test.ts src/routes/__tests__/channel-workflow-replies.test.ts scripts/__tests__/migration-order.test.ts scripts/__tests__/migration-renames.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsc --noEmit
```

From `apps/app-web` (confirmation cards, Attention and workspace registration):

```sh
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/vitest run src/components/chrome/__tests__/external-action-confirmation.test.tsx src/components/chrome/__tests__/chat-confirmation-card.test.tsx src/components/chat-app/__tests__/approval-review-chat.test.tsx src/lib/api/__tests__/pending-session-input.test.ts src/lib/__tests__/approvals-filter.test.ts src/lib/__tests__/external-approvals-api.test.ts src/components/doc/panels/__tests__/approvals-cache.test.tsx src/lib/api/__tests__/external-approval-sources.test.ts src/components/settings-modal/sections/__tests__/external-approvals-section.test.tsx src/components/settings-modal/__tests__/settings-modal.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsc --noEmit --incremental false
```

From `apps/api`, after building package dependencies, test the complete fresh migration chain as an ordinary owner and the embedded migration aliases:

```sh
BRIAN_TEST_MIGRATION_OWNER_GROUP=fresh NODE_OPTIONS=--max-old-space-size=6144 node --import tsx --test src/__tests__/migration-owner-role.test.ts
node --import tsx --test src/__tests__/migration-renames.test.ts
```

The explicit heap avoids the automatic diagnostic runner's 2 GiB limit. Focused SQL tests use ephemeral PGlite with mocked canonical helper bodies and notification/service ports; the fresh-chain test separately applies the real migrations. Neither proves multi-connection PostgreSQL races or live end-to-end delivery. Tests never connect to a live database.
