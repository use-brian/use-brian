# Watch recording API v1

Base: `/api/watch/v1`. JSON requests/responses except audio PUT. All responses have `Cache-Control: no-store`. UUIDs are client generated where specified; persist the exact session metadata before capture. No web recording endpoints are changed.

## Deployment prerequisites

Apply the current migration `650_watch_recording.sql` (it now includes preparation flags, publication guards and full-upload staging; a database with an earlier unreleased draft must be rebuilt/upgraded before testing this contract). Set `WATCH_RECORDING_ENABLED=true` and `WATCH_RECORDING_DEPLOYMENT` to a stable, unique installation identifier. Boot mounts this router only when Files API/storage are available, **before** broad human `/api` guards. PostgreSQL owner pool must have at least 2 slots (`PG_POOL_MAX`, default 4). ffmpeg/ffprobe and the existing recording-processing worker/provider must be deployed. Live `/retry` additionally requires enabled voice transcription. Feature is opt-in; it is not implied by a successful phone login. Gateway/Cloudflare access is separate and not bypassed.

## Credentials / provisioning

Human endpoints use the phone's ordinary `Authorization: Bearer <human JWT>`:

* `POST /grants`: `{ "deviceId": "UUID", "workspaceId": "UUID", "assistantId": "UUID", "label": "My Watch" }`. Label 1–80 characters. Only the selected workspace's **primary assistant** is supported. Returns 201:
  `{ "grantId": "UUID", "accessToken": "wra_…", "renewalToken": "wrr_…", "expiresIn": 900, "audience": "watch-recording-v1" }`.
  Provisioning is idempotent on `(owner, deviceId, workspaceId, deployment)` while the grant is nonrevoked. Retry the SAME body after timeout: returns the same grant and initial token pair (no duplicate grant, no credential reset). Label/assistant changes return 409 `provisioning_conflict`. After device rotation, replay returns 409 `grant_already_rotated_use_relay`; expired grants return 409 `grant_expired_use_relay`. Use relay for recovery, not replacement provisioning. Explicit revocation permits fresh provisioning but intentionally blocks the old grant's recovery: drain old captures via relay BEFORE revoking/replacing a grant. Maximum 10 active grants per user. Initial credentials are derived with a domain-separated server HMAC key, not stored in plaintext; server JWT-secret changes can make old provisioning replays return the rotated conflict. Rotation still uses fresh random credentials. `expiresIn` on replay is the remaining access lifetime (possibly zero); provisioning never extends expiry.
* `GET /grants`: `{ "grants": [{ "grantId", "deviceId", "workspaceId", "assistantId", "label", "revokedAt": null, "expiresAt": "ISO timestamp" }] }`.
* `DELETE /grants/:grantId`: 204, idempotent, owner-only; nonexistent/other-owner IDs also return 204.

`POST /renew` has no access-token requirement. JSON `{ "renewalToken": "wrr_…" }`; returns the same credential shape as provisioning, HTTP 200. Grant lifetime: 90 days, not extended on rotation. Access lifetime: 15 minutes. Rotation immediately invalidates the old access token. Reusing an already-consumed renewal token **revokes the entire grant**, including newly rotated credentials. Persist replacement credentials atomically and use one renewal coordinator on the watch; the phone must never race or participate in rotation. A lost successful renewal response requires human relay recovery (do NOT repeatedly replay the old secret). Only hashes are stored server-side.

Direct `/sessions/...` endpoints below require `Authorization: Bearer <wra_…>`. Human JWTs do not substitute on the direct paths; they use the dedicated relay prefix below. Device tokens cannot call human/general APIs. Every call rechecks membership and primary assistant binding. Revocation blocks subsequent requests. Phone relay uses the SAME watch grant identity through the human-authenticated relay prefix; never provision another grant just to upload queued audio. Grant identity + clientId is the session namespace; switching grants/accounts/workspaces must not silently re-upload old captures as new sessions. Sign-out/unpair should explicitly revoke; ordinary phone logout does not automatically revoke grants.

## Phone recovery relay — exact paths (implemented)

Use the phone's **human JWT**, never the watch renewal secret. Prefix every session operation with `/relay/:grantId`:

* `PUT /api/watch/v1/relay/:grantId/sessions/:clientId`
* `GET /api/watch/v1/relay/:grantId/sessions/:clientId`
* `PUT /api/watch/v1/relay/:grantId/sessions/:clientId/windows?...`
* `POST /api/watch/v1/relay/:grantId/sessions/:clientId/retry`
* `POST /api/watch/v1/relay/:grantId/sessions/:clientId/finalize`
* `POST /api/watch/v1/relay/:grantId/sessions/:clientId/full-upload`

Bodies, queries, receipts, status, errors and idempotency are IDENTICAL to direct device operations below: both mount the very same Express session router. The server resolves the grant from the path + authenticated owner + configured deployment, never a caller-supplied owner/workspace. Another owner's, another deployment's, or revoked grant returns 404 `relay_grant_not_found`. Current membership and frozen primary-assistant binding are checked on every request and again before expensive publication. A device token cannot authenticate relay.

Relay works when the watch is offline, its access token is expired, or the 90-day device grant is expired, provided the grant is **not revoked**, the human still has membership, and the capture has not expired. It does not renew/re-enable watch credentials. Expired capture retention (410) still applies. The trusted server-side relay mode is not accepted as a JSON/query field. Phone/watch deliveries of the same window converge on the SAME grant/clientId/session/page/recording. The phone must not participate in watch renewal-token rotation; provisioning credentials are transferred to the watch and renewal is watch-owned. Keep `grantId` alongside all local/recovery manifests.

## Capture / durable receipt

1. `PUT /sessions/:clientId` (clientId UUID):
   `{ "capturedAt": "2026-01-01T12:00:00Z", "title": "Meeting", "source": "apple-watch" }`.
   Title 1–120 characters; timestamp must be ISO 8601 with timezone. Returns 200 status below. Exact replay returns the same session/page IDs. Changed metadata returns 409. Destination is frozen in the grant; do not send workspace/page/assistant/anchor fields. A new canonical page is prepared only once, never an arbitrary existing page. Repeated PUT verifies that the previously prepared page still exists; deletion/inaccessibility gives 409 `page_unavailable`, including after finalize. A crash after creation intent with no visible page gives 409 `page_preparation_uncertain` rather than recreating a possibly deleted page. GET never prepares, recreates or mutates pages. Status includes `pagePrepared`: after an ambiguous initial PUT, retry that PUT if it is false; finalize refuses an unprepared page without sealing the capture.
2. `PUT /sessions/:clientId/windows?sequence=0&offsetMs=0&durationMs=15000&sha256=<64 lowercase hex>`.
   Body: **raw independently decodable M4A bytes**, `Content-Type: audio/mp4`. NOT multipart or base64. No filename field. Sequence starts at 0. SHA-256 is over the exact body. Limits: 2 MiB/window, 1–60000ms/window; server probes actual duration (1000ms tolerance). Returns 200 `{ "received": true, "sequence": 0, "sha256": "…" }` only after audio and metadata are committed in PostgreSQL. This is a durable receipt, **not transcription completion**.
   Out-of-order arrival is supported. Exact duplicate is a no-op, even after sealing. Different checksum/timing/length at the same sequence returns 409. Sequence ordering must agree with nonoverlapping offsets. On timeout, GET status then retry identical bytes; never increment sequence just because a request timed out.
3. `POST /sessions/:clientId/retry`, no body needed. Explicitly advances live transcription of the contiguous prefix starting at sequence 0; returns 200 status. **Audio PUT does not invoke transcription**: live clients must call `/retry` after receiving windows, and repeat while contiguous windows remain pending. Each call performs at most 3 new window transcriptions. Failed provider call returns 503 but receipt survives; reconcile GET and retry with backoff. Maximum 5 attempts/window; after that 409 `transcription_retry_limit` (finalize/batch processing still works). Model results are persisted before idempotent publication into the existing live transcript pane. Missing earlier windows block later publication. There is no autonomous live queue/drainer. **After finalize**, the same bodyless endpoint explicitly retries **failed canonical processing**: it reauthorizes the grant/destination, locks and rereads the capture/recording, and atomically enqueues one normal recording-worker job plus changes `processing` from `failed` to `queued`. Returns 200 with the usual session status; `state` remains `finalized`, and page/recording/media IDs and canonical scope are unchanged. It does not require live transcription configuration. `queued`, `processing`, and `processed` are no-ops; an existing active job prevents duplicate enqueue and its status is not overwritten. Clients must call this branch only on explicit user retry/force of a failed recording, not on background polling. Lost responses can be reconciled with GET and the same POST; `capture_busy` remains retryable. The human recovery relay has identical behavior.

## Reconciliation / status

`GET /sessions/:clientId` returns 200:

```json
{
  "clientId": "UUID",
  "sessionId": "UUID",
  "pageId": "UUID",
  "recordingId": null,
  "state": "open",
  "pagePrepared": true,
  "fullUpload": null,
  "expiresAt": "ISO timestamp",
  "finalization": null,
  "missingSequences": [1],
  "missingTimeRanges": [{"fromMs":15000,"toMs":30000}],
  "windows": [
    {"sequence":0,"offsetMs":0,"durationMs":15000,"sha256":"…","bytes":12345,"transcription":"ready"},
    {"sequence":2,"offsetMs":30000,"durationMs":15000,"sha256":"…","bytes":12345,"transcription":"pending"}
  ],
  "processing": null
}
```

Windows are sorted by sequence. `transcription`: `pending | failed | ready`; failed means attempted without a saved result, not lost audio. No transcript text or audio URLs are returned to device credentials. Before finalize, missing indices are reported through the highest received sequence, not through an unknown future end. `recordingId` stays null until canonical publication/finalization completes. `state`: `open | sealed | finalized`; expired sessions return 410. `processing` after finalize uses existing recording statuses (`queued | processing | processed | failed`, potentially `awaiting_upload` during recovery). Status does not automatically retry processing; explicit `POST /sessions/:clientId/retry` recovers failed processing as described above.

## Finalize

`POST /sessions/:clientId/finalize`:
`{ "expectedWindows": 3, "allowIncomplete": false }` (allowIncomplete defaults false).

Expected count: 1–1080. Missing indices produce 409 `missing_windows`, with `detail: { "missingSequences": [...] }`; the session remains open so missing windows can arrive. Known timestamp gaps also require explicit incomplete acknowledgement: 409 `missing_audio_time` with `detail.missingTimeRanges` (`fromMs`, `toMs`). GET status always reports these ranges, including an initial offset greater than zero. An existing index >= expected count gives 409 `unexpected_windows`. No windows gives 409 `no_windows`.

Only use `allowIncomplete:true` after explicit user acknowledgement. It permits assembly with missing windows; gaps are removed rather than padded with silence. Original `capturedAt` is stamped into canonical `episodes.occurred_at` by migration 650 BEFORE INSERT, before canonical scope lineage is recorded; no post-publication provenance mutation. Accepted finalization seals the exact intent durably, then assembles in sequence order with ffmpeg, admits one canonical workspace media file/recording, links the same page, and atomically queues existing batch processing. Returns 200 status with `state:"finalized"`, `recordingId`, and `finalization:{expectedWindows,allowIncomplete,source:"windows"}`. `finalized` means queued durably, not processed. Batch processing requires the existing worker and does not depend on live transcript success.

Retry the EXACT finalize body after timeout/503. Stable page ID, stable file path, canonical file-to-recording intake, and transactional queue/finalize prevent duplicate recordings/pages/jobs. Changed intent returns 409 `finalization_conflict`. Once sealed, new windows return 409 `capture_sealed`; exact already-received window replays remain safe. Storage/provider failure leaves a resumable sealed session. No cancel/unseal endpoint in v1.

## Limits, retention, errors, gaps

* 1080 windows; timeline <=180 minutes; 64 MiB raw audio/capture, 128 MiB retained raw audio/user; maximum 3 open/sealed unexpired captures/user across grants. No unlimited captures/uploads.
* Sessions expire 30 days after creation. Raw chunks are reclaimed by a boot-wired 15-minute sweep and lazily on session creation. Each sweep considers at most 20 expired candidates and processes at most 5 unlocked captures and 1000 expired renewal hashes; backlogs take multiple sweeps. Sweeps never overlap within a process; shutdown stops the unreferenced timer and drains in-flight work. When the feature/API is stopped, physical cleanup is delayed. Expiry is enforced regardless. Canonical media/page/recording follow existing workspace retention, not the chunk expiry. Retain local audio until receipt; retain a recovery copy through finalization where possible.
* Errors are `{ "error": "machine_code", "detail"?: ... }`. 400 invalid request/type, 401 expired/revoked/invalid credentials, 403 membership/destination unavailable, 404 session not found (including another grant's session), 409 conflict/busy/sealed, 410 expired, 413 quota/body too large, 422 checksum/audio/duration mismatch, 429 device/active-session quota, 503 temporary storage/provider failure or live unavailable. Retry 409 `capture_busy` and 503 with jittered exponential backoff; GET status after ambiguous failures. Expensive operations are keyed by capture and bounded to `min(4, PG_POOL_MAX - 1)` per API process (default 3), leaving one owner-pool slot free for nested store work. Unrelated captures can run concurrently. Same-capture contention returns 409 `capture_busy`; capacity saturation returns retryable 503 `watch_work_capacity`. Cross-replica advisory locks serialize each capture and coordinate cleanup.
* Full-file fallback uses the API-owned signed staging endpoint below, not cloud storage URLs or ordinary web upload endpoints.
* Live transcript is supported via explicit `/retry`; rolling AI notes/blueprint synthesis are not implemented. Final batch transcript/media, including full-file fallback, use the existing recording worker and linked page, with no second notes page requested.
* No hardware, production storage/provider, or full-schema end-to-end deployment verification is implied. Physical watch background networking and gateway access remain deployment/device validation work.

## Verification in this implementation

Targeted command (from `packages/api`):

```sh
WATCH_MEDIA_TEST=1 WATCH_POSTGRES_TEST=1 \
  nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#ffmpeg nixpkgs#postgresql -c \
  node_modules/.bin/vitest run --maxWorkers=1 \
  src/recordings/__tests__/watch-*.test.ts \
  src/routes/__tests__/watch-*.test.ts \
  src/routes/__tests__/recording-live.test.ts \
  src/routes/__tests__/recordings-open.test.ts
```

89 tests passed across twelve suites, including real-media and real-PostgreSQL lanes. Store tests execute migration/SQL in PGlite (idempotent provisioning, credential hashing/rotation/replay revocation, owner/deployment relay isolation including expired grants, pre-insert original capture timestamp provenance, receipts, metadata conflicts, missing windows/timing, sealing, byte/session quotas, expiry cleanup). Service tests use mocked external boundaries for ordered transcription, partial failures/publication retries, canonical intake and idempotent finalize/queue. HTTP tests run Express 5 with Supertest, including human/device separation and rejected async handlers. Boot test verifies registration order and provider wiring in source; it is not a deployed boot smoke test. Existing web recording routes remain unchanged and their 36 tests passed.

Real ffmpeg/ffprobe 9.0.1 was provisioned via Nix. Generated independently decodable 440Hz and 880Hz AAC/M4A fixtures passed decode/duration validation, corrupt/playlist rejection, assembly, playable output probing and PCM frequency-order checks. Run the real fixture lane explicitly:

```sh
WATCH_MEDIA_TEST=1 nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#ffmpeg -c \
  node_modules/.bin/vitest run src/recordings/__tests__/watch-media-real.test.ts --maxWorkers=1
```

Without `WATCH_MEDIA_TEST=1`, that real-media suite is explicitly skipped, not claimed as a pass. A temporary PostgreSQL 18.6 cluster also passed multi-connection tests for concurrent provisioning/session/receipt idempotency, upload reservation quotas, independent capture work, and cleanup skipping active work while expiry still prevents publication. Set `WATCH_POSTGRES_TEST=1` with PostgreSQL binaries on PATH to run that lane; otherwise it explicitly skips.

The parent built local workspace dependencies and verified the full API typecheck after adding an explicit `Router` return annotation; its 95 targeted tests passed. After the human root-file changes below, `packages/api/node_modules/.bin/tsc --noEmit -p packages/api` was rerun successfully (exit 0), and all 82 tests in the command above passed again. The subsequent explicit failed-processing recovery change also passed full API typecheck, 89 targeted tests across 12 suites, and both real canonical integration tests (none skipped). Those canonical tests now exercise exhausted-job failure, explicit HTTP retry, one replacement job, and no duplicate jobs for queued/processing/processed states.

**Real canonical integration: 2 tests executed and passed, none skipped.** `watch-canonical-intake.integration.test.ts` uses the guarded local fixture, complete migrations including 650, non-bypass app-role stores, real local-disk signed HTTP transfers, and ffmpeg. Both window finalization and partial-window/full-file fallback verify page/file/Episode/recording creation, original `capturedAt` preserved through processing, idempotent finalize before and after job completion, upload URL renewal/replay, outsider RLS isolation, readable playback, and real queue claim/processor/transcript publication. Only transcription and the external Pipeline-B semantic port are deterministic fixtures; canonical stores are not mocked.

Run from the repository root with PostgreSQL (`vector` and `pg_trgm`) and ffmpeg/ffprobe installed:

```sh
node scripts/crm/local-fixture.mjs -- \
  packages/api/node_modules/.bin/vitest run --root packages/api \
  --config vitest.integration.config.ts \
  src/recordings/__tests__/watch-canonical-intake.integration.test.ts --maxWorkers=1
```

Exact executed command in this environment (the temporary `--pg-bin` directory wraps Nix PostgreSQL 18.6 with pgvector):

```sh
nix --extra-experimental-features 'nix-command flakes' shell nixpkgs#ffmpeg -c \
  node scripts/crm/local-fixture.mjs --pg-bin /tmp/watch-canonical-pg-tools-t74IhF -- \
  packages/api/node_modules/.bin/vitest run --root packages/api \
  --config vitest.integration.config.ts \
  src/recordings/__tests__/watch-canonical-intake.integration.test.ts --maxWorkers=1
```

The integration exposed and fixed missing page-author provenance and incorrect assistant attribution on original human-recorded audio. Grant authorization remains primary-assistant-only, but the canonical root file and recording have a **null assistant partition**, inheriting admitted human-upload scope rather than inventing assistant-generated provenance. Migration 650 enforces that partition during timestamp stamping. Rebuild databases using earlier unreleased drafts of migration 650.

Cloud storage, real transcription/Pipeline-B providers, deployed worker lifecycle, hardware recovery, and production load testing remain unverified.

## Full-file fallback and signed URL renewal — implemented (API-owned staging)

Control endpoint (device access token, or the identical human relay prefix):

`POST /api/watch/v1/sessions/:clientId/full-upload`

```json
{"sha256":"64 lowercase hexadecimal characters","bytes":1234567,"durationMs":60000}
```

Only M4A (`audio/mp4`) is accepted. Size is 1–64 MiB and duration 1–10800000ms. The descriptor is immutable and reserves bytes against the owner's 128 MiB quota immediately, including both received window bytes and reserved full-file bytes. Each capture may retain up to 64 MiB of windows plus one 64 MiB full file; total owner quota still applies. Quota applies even before full receipt, so abandoned upload reservations cannot be multiplied without bound.

Returns HTTP 200:

```json
{
  "uploadUrl":"/api/watch/v1/uploads/SERVER_CAPTURE_UUID?token=SIGNED_CAPABILITY",
  "method":"PUT",
  "uploadHeaders":{"Content-Type":"audio/mp4","Content-Length":"1234567"},
  "expiresAt":"ISO timestamp (5 minutes from issuance)",
  "sessionId":"SERVER_CAPTURE_UUID",
  "received":false
}
```

`uploadUrl` is a **same-origin relative URL**: resolve against the configured API origin, never another account/server. It is not a cloud bucket URL. PUT raw file bytes to it with the given headers and no Brian Authorization token (gateway access requirements still apply). Exactly the declared Content-Length is required; no chunked/compressed transfer. The API authenticates the signed capability BEFORE reading the body, enforces a byte ceiling, validates SHA-256 and actual MP4 duration, and persists one immutable PostgreSQL bytea snapshot. Body reception has a 5-minute maximum. This trades DB storage/HTTP bandwidth for a small, safe, cross-adapter implementation; configure deployment request-body/timeout limits accordingly (some gateways cap requests below 64 MiB).

Successful PUT: HTTP 200 `{ "received": true, "sessionId": "UUID", "sha256": "…", "bytes": 1234567 }`.

**Renewal:** call `POST .../full-upload` again with the EXACT same descriptor. It returns a fresh five-minute URL for the SAME capture/descriptor; it creates no page, file, Episode, recording or processing job. Changed descriptor returns 409 `full_upload_conflict`. Old URLs remain valid until their original expiry, but can only deliver the same immutable bytes. A lost PUT acknowledgement is reconciled through GET session status: `fullUpload` is `{sha256,bytes,durationMs,received}` (or null before initialization). Exact duplicate PUT is safe. Neither renewal nor replay can overwrite the received bytes.

The capability binds deployment, owner, grant, capture, checksum, size, duration and device-vs-relay authority. Membership, grant revocation, capture expiry, and signature expiry are rechecked at receipt. Relay-minted URLs work after device-grant expiry; device-minted URLs do not. Phone logout alone does not invalidate an already minted five-minute URL; grant revocation does. Never log/share the signed URL. Wrong path/deployment, tampering or expired signature gives 401 `invalid_upload_token`; missing/wrong length gives 411 `exact_content_length_required`; unsupported encoding/type gives 415; checksum/length mismatch gives 422 `checksum_or_length_mismatch`.

**Full-file finalize:**

`POST .../sessions/:clientId/finalize` (same relay prefix also supported)

```json
{"source":"full","expectedWindows":0,"allowIncomplete":false}
```

`source` defaults to `windows` for backward compatibility. Full finalize requires verified full-file receipt (otherwise 409 `full_upload_missing`, remaining open), not all provisional windows. `expectedWindows` may be 0 and is informational for full mode; any known window extending beyond the declared full duration by more than 1000ms gives 409 `full_upload_coverage_conflict`. The declared full file is the authoritative complete audio, so clients must never label a partial recovery file as complete.

Once accepted, finalization freezes the source and exact intent. Subsequent source/intent changes give 409 `finalization_conflict`. Full and window modes use the **same stable media-file path, reserved recording ID, original capturedAt, linked page, canonical file intake, and atomic worker enqueue**. Full mode uses staged bytes directly, never concatenates or queues a second pipeline. No recording is created during URL issuance or renewal. If window finalization has already been sealed, full replacement is not allowed.

## Expiry and publication safety

Cleanup acquires the same capture advisory lock as transcription, preparation, signed upload, and finalize; locked work is skipped, not purged underneath. Expiry never extends because work is in progress: saved transcript/publication SQL and the final queue/state transaction use `clock_timestamp()` predicates. SQL guards cover the watch-owned page/media/Episode publication destinations after asynchronous external calls. If expiry occurs mid-operation, publication/finalization fails and queued work rolls back; a capture in `expired` state cannot be finalized back to life. Temporary unreferenced storage objects from failed publication follow existing storage orphan retention.

Window/full staging bytes are deleted together when the capture expires. Prepared pages/canonical recordings retain existing workspace retention rules; expired capture cleanup never recreates or redirects them.
