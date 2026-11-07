# External human approvals

External approvals are display-only, one-time decisions in Brian's existing approval queue. They never execute a Brian tool or resume a workflow. A separate relay consumes the decision and acknowledges its own attempt; an approval, notification, or receipt is not proof of tool execution.

## Workspace setup

A workspace owner or administrator opens **Workspace settings > External approvals**:

1. Name the external application, choose an assistant and a human workspace member.
2. Choose **Web inbox**, or the approver's **verified recent channel**. The latter prefers a messaging channel with an unambiguous pinned integration, and otherwise accepts the approver's recent personal web chat with the same assistant. Missing verification fails closed; arbitrary destination IDs are not accepted.
3. Select **Register application**. Copy the newly issued credential into the external application's approved secret storage, then dismiss it. Brian shows plaintext only once and persists only its SHA-256 digest and display prefix.
4. Configure the external application to use that credential for the relay endpoints below. No Brian server allowlist, environment-variable change or API restart is required.

The assistant must be in this workspace and visible to both the administrator and the approver. Registration does not delegate approval authority to the administrator or external application: only the designated human may decide a request.

The screen lists source IDs, credential prefixes, assistant, approver, notification destination and revocation state. **Rotate credential** immediately invalidates the old bearer without changing the source binding or existing human evidence. **Revoke credential** permanently disables ingestion, polling, decisions and unconsumed receipts for that registration. To change the assistant, approver or destination, revoke and create a new registration. Revocation does not undo actions already taken by an external application.

Credentials live only in the one-time response and the mounted reveal component, never in the surface cache or browser storage. Switching workspace/viewer or closing the screen discards the reveal. On an ambiguous network failure, refresh the source list before retrying; if issuance succeeded but its response was lost, rotate that source to obtain a new credential. Do not automatically replay credential mutations.

The existing delivery dispatcher applies its destination-audience gate. Verified-channel and personal web-chat notifications use a confirmation-style card: frozen request title, optional message details, Allow/Deny actions (or `approve`/`reject` reply text), and a deep link into the Approvals panel. Workflow-step pushes still omit tool arguments. A failed notification leaves web review available and is not evidence of delivery. Web-inbox sources (`channelId: queue`) cannot grant channel consent; personal web-chat destinations remain Approvals-panel authoritative for typed replies in v1.

### Workspace management API

These endpoints require ordinary Brian user authentication, not the source bearer. They are owner/admin-only and are not exposed as model/MCP tools. Mutations additionally require a live authenticated human session; the session ledger, current administrator role, approver membership and assistant visibility are revalidated in the write transaction.

Base: `/api/workspaces/:workspaceId/external-approval-sources`.

- `GET /`: `{sources:[...]}` containing public metadata only, never a digest or bearer.
- `POST /`: strict `{name,assistantId,approverUserId,notification:'web'|'verified_channel'}`; returns HTTP 201 `{source,token}` once. Notification defaults to `web`.
- `POST /:sourceId/rotate`: exactly `{}`; returns `{source,token}` once.
- `DELETE /:sourceId`: revokes the registration; returns HTTP 204.

Issuance responses use `Cache-Control: no-store`. Authority identifiers and source IDs are server-bound, not incoming request metadata. Registry reads are live and approval transactions lock and revalidate the current registration, so stale snapshots cannot survive rotation or revocation. Source bindings cannot be edited or revived. Creation, last rotation and revocation retain actor/timestamp metadata. Removing an assistant/member makes the source inapplicable; it does not block their deletion. Workspace erasure removes its credential metadata.

### Database rollout

Apply `8241_external_human_approvals.sql`, `8242_workspace_external_approval_sources.sql`, and `8243_external_approval_web_chat_destination.sql` through the normal reviewed migration process. The first adds the immutable transport sidecar; the second adds workspace registrations; the third allows verified personal web-chat destinations in addition to the Approvals-panel inbox. Both native and embedded runners recognize the previous filenames `8240_external_human_approvals.sql` and `8241_workspace_external_approval_sources.sql`, preserving their existing ledger timestamps without replaying applied DDL. Existing workspace registrations and credentials remain valid; do not delete or rewrite the migration ledger to force a replay. Previously provisioned server allowlist entries are not automatically imported: register those applications through workspace settings and replace their caller credentials.

Both sidecars enable RLS without tenant policies: transport data and credential digests are owner/service-only. The controlled implementation uses `getPool()` (`DATABASE_URL`, schema owner), not `getAppPool()` (`DATABASE_URL_APP`, non-owner `app_user`). Do not grant tenant access to these tables or disable RLS. Existing queue projections retain tenant RLS plus the assigned human and current-source checks. No live migration or credential provisioning is implied by these implementation instructions.

## Authenticated relay contract

All endpoints require `Authorization: Bearer <source bearer>` and return only lifecycle state. They are mounted before user authentication at `/internal/external-approvals`, not under `/api`.

- `POST /internal/external-approvals`: `{externalRequestId, taskId, sessionId, request, expiresAt}`.
- `GET /internal/external-approvals/:externalRequestId`: poll current applicable state.
- `POST /internal/external-approvals/:externalRequestId/ack`: `{status:'applied'|'stale'|'failed'}`.
- `POST /internal/external-approvals/:externalRequestId/cancel`: exactly `{}`.

`request` is `{method:'confirm',title,message?}` or `{method:'select',title,message?,options:['Allow once','Deny']}`. No extra fields, executable callbacks, tools, transport data, identity or destination are accepted. No strings are truncated. Title is bounded to 16,384 characters, message to 32,768; correlation IDs to 200. External request IDs contain only ASCII letters, numbers, `_`, `.`, `:`, `-`. Other text rejects control characters except newline, tab and carriage return. `expiresAt` must be an ISO date-time with timezone and initially in the future. Effective expiry is the earlier of incoming expiry and initial ingestion + five minutes; retries never extend it.

All responses have `{approvalId,externalRequestId,status,expiresAt,payloadHash,ackStatus?}`. Status is `pending|approved|rejected|expired|superseded`. Missing/invalid bearer is 401; invalid input 400; unavailable/foreign/revoked source 404; immutable replay conflict or conflicting acknowledgement 409. Replays return the same approval, hash and effective expiry without creating a new notification.

### Payload hash

SHA-256 lowercase hex of UTF-8 `JSON.stringify` of the normalized object in this exact field order:

```
{externalRequestId, taskId, sessionId, request, expiresAt}
```

`request` is reconstructed in order `method,title,message?,options?`; optional fields absent from the input are omitted. The hash uses the **incoming expiry normalized with `new Date(expiresAt).toISOString()`**, not the capped effective expiry. Full immutable input, including the display snapshot, participates in the hash. The relay must separately validate effective expiry, task/session/request identity, immutable snapshot and its own pending callback before applying a decision.

### Decision and receipt semantics

Only the configured, currently authorized human may resolve `external_action`, through the unified queue's `/api/approvals/:id/respond` (`approved|rejected`) or deterministic typed `approve <id-prefix>` / `reject <id-prefix>` channel commands. Channel decisions additionally require the exact configured channel ID and pinned integration; a web-only source or an unpinned integration cannot use channel consent. The web card shows the full frozen title/message/options as plain text, offers only Allow once/Reject, and excludes these requests from bulk approval. The notification presents the frozen request for an inline Allow/Deny decision and still links to the Approvals panel. Ambiguous or unavailable prefixes are consumed without invoking the model. External requests cannot use delegated review assignments, prior delegated receipts, learned patterns, standing grants, permanent approvals, or generic `PendingApprovalsStore.respond`.

Insertion is transactional and source-key serialized. Every decision locks the native pending row, verifies current source authority and checks the database clock in its final write. Only one approve/reject wins. Expired pending requests become expired. A recorded human decision is never rewritten merely because its expiry elapses: polling projects unacknowledged elapsed decisions as `expired`, and an `applied` receipt is then refused. An existing receipt remains historical, not a renewed grant.

Receipts are separate from human decisions. Both approval and denial can be acknowledged `applied`; `stale`/`failed` record relay outcomes. Receipt replay is idempotent; changing a recorded receipt is a conflict. No acknowledgement can grant permission. Cancellation invalidates pending or unacknowledged approved requests as `superseded`; sidecar `superseded_at` preserves an existing human approval and its timestamp as audit evidence. It does not supersede an already acknowledged applied decision. The relay must still close its local pending callback atomically before sending cancellation: Brian cannot retract an action the relay has already executed.

## Focused verification

From `packages/api`, with existing dependencies (141 focused protocol, management, SQL, channel-routing and migration compatibility tests):

```sh
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/vitest run src/external-approvals/__tests__ src/workflow/__tests__/approval-replies.test.ts src/workflow/__tests__/approval-deliveries.test.ts src/workflow/__tests__/recent-approval-channel.test.ts src/routes/__tests__/approvals.test.ts src/routes/__tests__/channel-workflow-replies.test.ts scripts/__tests__/migration-order.test.ts scripts/__tests__/migration-renames.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsc --noEmit
```

From `apps/api`, after building package dependencies, verify fresh and previously applied embedded migration filenames without a live database:

```sh
node --import tsx --test src/__tests__/migration-renames.test.ts
```

From `apps/app-web` (60 focused tests, including workspace registration and existing cache/filter regressions):

```sh
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/vitest run src/lib/__tests__/approvals-filter.test.ts src/lib/__tests__/external-approvals-api.test.ts src/components/doc/panels/__tests__/approvals-cache.test.tsx src/lib/api/__tests__/external-approval-sources.test.ts src/components/settings-modal/sections/__tests__/external-approvals-section.test.tsx src/components/settings-modal/__tests__/settings-modal.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsc --noEmit --incremental false
```

The explicit heap avoids the automatic diagnostic runner's 2 GiB limit; both full TypeScript checks complete with this setting.

The SQL tests use ephemeral in-memory PGlite, mock the service pool and notification port, apply the actual migration, exercise SQL lifecycle/races, and verify non-owner RLS denial. They never connect to a live database. PGlite serializes its single connection, so these tests do not substitute for a multi-connection PostgreSQL stress test.
