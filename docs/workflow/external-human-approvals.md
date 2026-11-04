# External human approvals

External approvals are display-only, one-time decisions in Brian's existing approval queue. They never execute a Brian tool or resume a workflow. A separate relay consumes the decision and acknowledges its own attempt; an approval, notification, or receipt is not proof of tool execution.

## Provisioning (no live actions required)

The API process accepts `BRIAN_EXTERNAL_APPROVAL_SOURCES`, a JSON array. Unset or `[]` disables ingestion. Invalid configuration (including duplicate source IDs or token digests, unknown fields, invalid UUIDs or channel types) prevents startup. Do not put raw tokens in this configuration or log authorization headers.

Each entry has exactly:

```json
{
  "id": "sandbox-relay",
  "tokenSha256": "<64 lowercase hexadecimal characters: SHA-256 of the separately provisioned bearer>",
  "workspaceId": "<workspace UUID>",
  "assistantId": "<assistant UUID>",
  "approverUserId": "<assigned human UUID>",
  "channelType": "web",
  "channelId": "queue"
}
```

`channelType` supports `web`, `telegram`, `slack`, `whatsapp`, `feishu`, `msteams`, `custom`; `channelIntegrationId` is an optional UUID. Use a verified human destination and pin its owning integration for channel delivery. The existing delivery dispatcher applies its destination-audience gate; notifications contain only a generic deep link, never external task/session IDs, title, message or options. Delivery failures leave the authenticated web queue available and are not evidence of delivery.

Provision the bearer separately through your approved secret-management mechanism. This document does not generate or retrieve credentials. Limit network access to the relay as well as authenticating it. Source IDs are durable namespaces: do not repurpose an ID. Changing configured workspace, assistant, human, channel or integration invalidates prior requests. Token rotation alone preserves them. Removing a source disables its outstanding requests. Current workspace membership and assistant placement admission are checked on ingestion, reads and decisions, not trusted from a source payload.

Apply migration `8240_external_human_approvals.sql` using the normal offline/reviewed migration process before enabling the source. It adds only `external_approval_requests`: a unique `(source_id, external_request_id)` sidecar linked to `pending_approvals`, binding hash, immutable input/hash, external correlation IDs, effective expiry and acknowledgement. It enables RLS without tenant policies: transport data is owner/service-only. The implementation uses `getPool()` (`DATABASE_URL`, the schema owner), not `getAppPool()` (`DATABASE_URL_APP`, non-owner `app_user`). Do not grant tenant access to the sidecar or disable RLS to make a misconfigured service role work. Existing queue projections use their usual tenant RLS plus the assigned human/current-source check.

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

Only the configured, currently authorized human may resolve `external_action`, through the unified queue's `/api/approvals/:id/respond` (`approved|rejected`) or deterministic typed `approve <id-prefix>` / `reject <id-prefix>` channel commands. Channel decisions additionally require the exact configured channel ID and pinned integration; a web-only source or an unpinned integration cannot use channel consent. The web card shows the full frozen title/message/options as plain text, offers only Allow once/Reject, and excludes these requests from bulk approval. The notification directs the human to review the web request before deciding. Ambiguous or unavailable prefixes are consumed without invoking the model. External requests cannot use delegated review assignments, prior delegated receipts, learned patterns, standing grants, permanent approvals, or generic `PendingApprovalsStore.respond`.

Insertion is transactional and source-key serialized. Every decision locks the native pending row, verifies current source authority and checks the database clock in its final write. Only one approve/reject wins. Expired pending requests become expired. A recorded human decision is never rewritten merely because its expiry elapses: polling projects unacknowledged elapsed decisions as `expired`, and an `applied` receipt is then refused. An existing receipt remains historical, not a renewed grant.

Receipts are separate from human decisions. Both approval and denial can be acknowledged `applied`; `stale`/`failed` record relay outcomes. Receipt replay is idempotent; changing a recorded receipt is a conflict. No acknowledgement can grant permission. Cancellation invalidates pending or unacknowledged approved requests as `superseded`; sidecar `superseded_at` preserves an existing human approval and its timestamp as audit evidence. It does not supersede an already acknowledged applied decision. The relay must still close its local pending callback atomically before sending cancellation: Brian cannot retract an action the relay has already executed.

## Focused verification

From `packages/api`, with existing dependencies (88 focused tests):

```sh
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/vitest run src/external-approvals/__tests__ src/workflow/__tests__/approval-replies.test.ts src/workflow/__tests__/approval-deliveries.test.ts src/routes/__tests__/approvals.test.ts src/routes/__tests__/channel-workflow-replies.test.ts --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsc --noEmit
```

From `apps/app-web` (37 focused tests, including the existing cache/filter regressions):

```sh
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/vitest run src/lib/__tests__/approvals-filter.test.ts src/lib/__tests__/external-approvals-api.test.ts src/components/doc/panels/__tests__/approvals-cache.test.tsx --maxWorkers=1
NODE_OPTIONS=--max-old-space-size=6144 node_modules/.bin/tsc --noEmit --incremental false
```

The explicit heap avoids the automatic diagnostic runner's 2 GiB limit; both full TypeScript checks complete with this setting.

The SQL tests use ephemeral in-memory PGlite, mock the service pool and notification port, apply the actual migration, exercise SQL lifecycle/races, and verify non-owner RLS denial. They never connect to a live database. PGlite serializes its single connection, so these tests do not substitute for a multi-connection PostgreSQL stress test.
