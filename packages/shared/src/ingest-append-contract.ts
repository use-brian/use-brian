/**
 * `ub.ingest.append.v1` — the published guidance schema for external ingest
 * sinks (docs/architecture/brain/ingest-external-sink.md → "The append
 * contract"; plan docs/plans/ingestion-external-endpoint.md §4).
 *
 * An external service that wants the platform's normalized event stream
 * implements ONE endpoint accepting this request shape and answering with
 * this response shape. The platform's relay worker
 * (`packages/api/src/ingest/external-sink-relay.ts`) is the only producer;
 * consumers include the wechat-brian / whatsapp-brian archive services.
 *
 * Contract rules (frozen — breaking changes bump the version, never mutate
 * in place, X8):
 *
 *   - Idempotency is the CONSUMER's job, keyed `(instance_id,
 *     provider_message_id)` per message (X4). The relay retries freely
 *     (at-least-once), so `INSERT ... ON CONFLICT DO NOTHING` on that key
 *     converges to exactly-once effect. `X-UB-Idempotency-Key` carries a
 *     whole-batch retry key as a cheap batch-level collapse.
 *   - `accepted + duplicates` MUST equal `messages.length` on success; any
 *     mismatch is a partial failure and the relay retries the whole batch.
 *   - `ack_cursor` is echoed ONLY after the sink durably committed the
 *     batch — it is what advances the platform-side cursor (X3).
 *   - Any non-200 is a retry (429/5xx, backoff) or dead-letter (other 4xx)
 *     signal (X7).
 *
 * The message record is the messaging-archive canonical record
 * (docs/plans/messaging-archive-connector.md §3a) verbatim, so a consumer
 * implementing this contract is compatible with every provider.
 *
 * This module is pure schema (zod + string constants) — no node imports, so
 * it stays browser-safe. The HMAC signing helper lives with the relay
 * (`packages/api/src/ingest/append-signing.ts`).
 *
 * Component tag: [COMP:shared/ingest-append-contract].
 */

import { z } from 'zod'

/** Contract identifier carried in every request and response body. */
export const INGEST_APPEND_CONTRACT_V1 = 'ub.ingest.append.v1'

/**
 * Whole-batch idempotency key header — the outbox row's `batch_id`, stable
 * across retries of the same batch.
 */
export const INGEST_APPEND_IDEMPOTENCY_HEADER = 'x-ub-idempotency-key'

/**
 * HMAC auth header (`auth_kind: 'hmac'`): `sha256=<hex>` of
 * HMAC-SHA256(secret, raw request body). Bearer auth uses the standard
 * `Authorization: Bearer <token>` header instead.
 */
export const INGEST_APPEND_SIGNATURE_HEADER = 'x-ub-signature'

/** JSON value passthrough for opaque fields (cursor, raw provider blob). */
const opaqueJson = z.unknown()

export const canonicalIngestMessageSchema = z.object({
  /** Idempotency key together with `instance_id`. */
  provider_message_id: z.string().min(1),
  conversation_id: z.string().min(1),
  sender_id: z.string(),
  sender_display: z.string().nullable(),
  /** RFC 3339 timestamp. */
  sent_at: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  kind: z.enum(['text', 'image', 'voice', 'file', 'link']),
  /** Text or transcript; null for pure-media records. */
  body_text: z.string().nullable(),
  /** Attachment METADATA only in v1 (messaging-archive D14). */
  media_ref: z
    .object({
      filename: z.string(),
      mime: z.string(),
      size_bytes: z.number().int().nonnegative(),
    })
    .nullable(),
  reply_to_provider_id: z.string().nullable(),
  /** Opaque provider payload kept for reparse; never interpreted here. */
  raw_provider_blob: opaqueJson.nullable(),
})

export type CanonicalIngestMessage = z.infer<typeof canonicalIngestMessageSchema>

export const ingestAppendRequestSchema = z.object({
  contract: z.literal(INGEST_APPEND_CONTRACT_V1),
  /** The `connector_instance` id — half of the per-message idempotency key. */
  instance_id: z.string().uuid(),
  /** Provider label (`wechat`, `whatsapp`, ...). Informational, never load-bearing (X1). */
  source: z.string().min(1),
  workspace_id: z.string().uuid(),
  /** Compartment owner for person-scoped corpora (D3); null when not person-scoped. */
  owner_user_id: z.string().uuid().nullable(),
  /** Opaque producer cursor; the sink echoes it back as `ack_cursor` once durable. */
  cursor: opaqueJson.nullable(),
  messages: z.array(canonicalIngestMessageSchema).min(1),
})

export type IngestAppendRequest = z.infer<typeof ingestAppendRequestSchema>

/**
 * Per-conversation coverage report (messaging-archive D11) — how an external
 * archive surfaces its own holes back to the platform. Optional in v1; the
 * schema reserves it.
 */
export const ingestAppendCoverageSchema = z.record(
  z.object({
    last_provider_message_id: z.string(),
    gaps: z.array(opaqueJson),
  }),
)

export const ingestAppendResponseSchema = z.object({
  contract: z.literal(INGEST_APPEND_CONTRACT_V1),
  /** Newly stored rows. */
  accepted: z.number().int().nonnegative(),
  /** ON CONFLICT skips — proof the consumer-side idempotency worked. */
  duplicates: z.number().int().nonnegative(),
  /**
   * The cursor the sink has durably committed. Advances the platform-side
   * cursor (X3). A 200 without it still marks the batch delivered (the
   * accepted/duplicates accounting proved storage) but moves no cursor.
   */
  ack_cursor: opaqueJson.optional(),
  coverage: ingestAppendCoverageSchema.optional(),
})

export type IngestAppendResponse = z.infer<typeof ingestAppendResponseSchema>
