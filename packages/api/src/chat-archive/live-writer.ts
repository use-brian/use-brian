/**
 * Local chat-archive producer. It owns no provider parsing: adapters pass an
 * IncomingMessage and normalize.ts emits the shared append contract.
 */

import type pg from 'pg'
import type { IncomingMessage, OutgoingDocument } from '@use-brian/channels'
import { getPool } from '../db/client.js'
import type { IngestSinkStore } from '../db/ingest-sink-store.js'
import type { ExternalSinkFanout } from '../ingest/external-sink-fanout.js'
import { normalizeInboundChatMessage, normalizeOutboundChatMessage } from './normalize.js'

type Queryable = Pick<pg.ClientBase, 'query'>
type ChannelSource = 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'email' | 'msteams' | 'wechat' | 'custom'

export type LiveArchiveContext = {
  source: ChannelSource
  ownerUserId: string
  workspaceId: string | null
  /** Exact channel connector when the route has one; avoids cross-account mixing. */
  connectorInstanceId?: string | null
  assistantId: string
  assistantName: string
  conversationId: string
}

/**
 * What binding resolution actually needs. Deliberately narrower than
 * `LiveArchiveContext`: the assistant fields identify who *answers*, and an
 * archived conversation need not have an answerer at all.
 */
type ArchiveBindingContext = Pick<
  LiveArchiveContext, 'source' | 'ownerUserId' | 'workspaceId' | 'connectorInstanceId'
>

export type LiveChatArchiveWriter = {
  /**
   * The archive instance id this context resolves to, creating the managed
   * binding if it does not exist yet.
   *
   * Attachment staging happens BEFORE the append, because the media reference
   * is part of the appended message — but the instance id is minted lazily by
   * `resolveBinding` during that append. A route that only had the channel
   * integration's `connector_instance_id` (often null) would either throw or,
   * worse, stage bytes under a different instance than the message row, which
   * keys assets by `(instance_id, provider_message_id)` and orphans them
   * silently. Exposing the same memoized resolver keeps both halves on one id.
   */
  resolveInstanceId(input: LiveArchiveContext): Promise<string | null>
  appendInbound(input: LiveArchiveContext & { message: IncomingMessage }): Promise<void>
  /**
   * Archive an inbound message on a conversation no assistant answers.
   *
   * Channel routes decide who *replies*; they are not a statement about what
   * belongs in the archive. An account carries conversations the assistant was
   * never added to, and dropping them left the archive holding backfilled
   * history for conversations that then silently stopped receiving live
   * messages — the same chat, half recorded.
   *
   * Takes a workspace rather than an owner because the caller has a channel,
   * not an assistant, and the owner is derivable from it.
   */
  appendUnroutedInbound(input: {
    source: ChannelSource
    workspaceId: string
    conversationId: string
    message: IncomingMessage
  }): Promise<void>
  persistInbound<T>(
    input: LiveArchiveContext & { message: IncomingMessage },
    persist: (client?: Queryable) => Promise<T>,
  ): Promise<T>
  appendOutbound(input: LiveArchiveContext & {
    sessionMessageId: string
    providerMessageId?: string | null
    text: string
    documents?: OutgoingDocument[]
    replyToProviderId?: string | null
  }): Promise<void>
}

function assertLoopbackAppendUrl(value: string): string {
  const url = new URL(value)
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (url.protocol !== 'http:' || !hosts.has(url.hostname)) {
    throw new Error('BRIAN_MESSAGE_STORE_URL must be an http loopback URL')
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/append'
  return url.toString()
}

export function createLiveChatArchiveWriter(deps: {
  endpointUrl: string
  secret: string
  sinks: Pick<IngestSinkStore, 'ensureManagedLocalChatArchive'>
  fanout: Pick<ExternalSinkFanout, 'fanout'>
  pool?: pg.Pool
}): LiveChatArchiveWriter {
  const endpointUrl = assertLoopbackAppendUrl(deps.endpointUrl)
  const pool = deps.pool ?? getPool()
  const bindings = new Map<string, Promise<{ instanceId: string; workspaceId: string } | null>>()

  async function resolveBinding(input: ArchiveBindingContext): Promise<{ instanceId: string; workspaceId: string } | null> {
    let workspaceId = input.workspaceId
    if (!workspaceId) {
      const workspace = await pool.query<{ id: string }>(
        `SELECT id FROM workspaces
          WHERE owner_user_id = $1 AND is_personal = true
          ORDER BY created_at ASC LIMIT 1`,
        [input.ownerUserId],
      )
      workspaceId = workspace.rows[0]?.id ?? null
    }
    if (!workspaceId) return null

    const key = `${workspaceId}:${input.source}:${input.connectorInstanceId ?? 'auto'}`
    let pending = bindings.get(key)
    if (!pending) {
      pending = (async () => {
        const existing = input.connectorInstanceId
          ? await pool.query<{ id: string }>(
              `SELECT id FROM connector_instance
                WHERE id = $1 AND provider = $2
                  AND (
                    (scope = 'workspace' AND workspace_id = $3)
                    OR ingest_workspace_id = $3
                    OR (scope = 'user' AND user_id = $4)
                  )
                LIMIT 1`,
              [input.connectorInstanceId, input.source, workspaceId, input.ownerUserId],
            )
          : await pool.query<{ id: string }>(
              `SELECT id FROM connector_instance
                WHERE scope = 'workspace' AND workspace_id = $1 AND provider = $2
                ORDER BY (config->>'managedBy' = 'local_chat_archive') ASC,
                         connected DESC, created_at ASC
                LIMIT 1`,
              [workspaceId, input.source],
            )
        let instanceId = existing.rows[0]?.id
        if (input.connectorInstanceId && !instanceId) return null
        if (!instanceId) {
          const inserted = await pool.query<{ id: string }>(
            `INSERT INTO connector_instance
               (scope, user_id, workspace_id, provider, label, custom,
                credentials_type, config, sensitivity, connected,
                ingestion_enabled, created_by)
             VALUES ('workspace', NULL, $1, $2, $3, false, 'none',
                     '{"managedBy":"local_chat_archive"}'::jsonb,
                     'internal', true, false, $4)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [workspaceId, input.source, `${input.source} chat archive`, input.ownerUserId],
          )
          instanceId = inserted.rows[0]?.id
          if (!instanceId) {
            const raced = await pool.query<{ id: string }>(
              `SELECT id FROM connector_instance
                WHERE scope = 'workspace' AND workspace_id = $1 AND provider = $2
                  AND config->>'managedBy' = 'local_chat_archive'
                LIMIT 1`,
              [workspaceId, input.source],
            )
            instanceId = raced.rows[0]?.id
          }
        }
        if (!instanceId) return null
        await deps.sinks.ensureManagedLocalChatArchive({
          connectorInstanceId: instanceId,
          workspaceId,
          endpointUrl,
          secret: deps.secret,
        })
        return { instanceId, workspaceId }
      })()
      bindings.set(key, pending)
      pending.catch(() => bindings.delete(key))
    }
    return pending
  }

  return {
    async resolveInstanceId(input) {
      const binding = await resolveBinding(input)
      return binding?.instanceId ?? null
    },

    async appendUnroutedInbound(input) {
      // The workspace owner is the archive's compartment key. Reading it here
      // rather than taking it from the caller keeps unrouted messages in the
      // same compartment as routed ones on the same channel — two owners for
      // one conversation would split it across the row-level security boundary
      // and make half of it invisible to search.
      const owner = await pool.query<{ owner_user_id: string }>(
        `SELECT owner_user_id FROM workspaces WHERE id = $1 LIMIT 1`,
        [input.workspaceId],
      )
      const ownerUserId = owner.rows[0]?.owner_user_id
      if (!ownerUserId) return
      const binding = await resolveBinding({
        source: input.source,
        ownerUserId,
        workspaceId: input.workspaceId,
      })
      if (!binding) return
      await deps.fanout.fanout({
        connectorInstanceId: binding.instanceId,
        workspaceId: binding.workspaceId,
        ownerUserId,
        source: input.source,
        messages: [normalizeInboundChatMessage({ source: input.source, message: input.message })],
        sourceCursor: { provider_message_id: input.message.messageId ?? null },
      })
    },

    async appendInbound(input) {
      const binding = await resolveBinding(input)
      if (!binding) return
      await deps.fanout.fanout({
        connectorInstanceId: binding.instanceId,
        workspaceId: binding.workspaceId,
        ownerUserId: input.ownerUserId,
        source: input.source,
        messages: [normalizeInboundChatMessage({ source: input.source, message: input.message })],
        sourceCursor: { provider_message_id: input.message.messageId ?? null },
      })
    },

    async persistInbound(input, persist) {
      let binding: { instanceId: string; workspaceId: string } | null
      try {
        binding = await resolveBinding(input)
      } catch (err) {
        console.warn('[chat-archive] inbound setup failed; saving session turn without archive:', err)
        return persist()
      }
      if (!binding) return persist()

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const stored = await persist(client)
        await deps.fanout.fanout({
          connectorInstanceId: binding.instanceId,
          workspaceId: binding.workspaceId,
          ownerUserId: input.ownerUserId,
          source: input.source,
          messages: [normalizeInboundChatMessage({ source: input.source, message: input.message })],
          sourceCursor: { provider_message_id: input.message.messageId ?? null },
        }, client)
        await client.query('COMMIT')
        return stored
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async appendOutbound(input) {
      const binding = await resolveBinding(input)
      if (!binding) return
      await deps.fanout.fanout({
        connectorInstanceId: binding.instanceId,
        workspaceId: binding.workspaceId,
        ownerUserId: input.ownerUserId,
        source: input.source,
        messages: [normalizeOutboundChatMessage({
          providerMessageId: input.providerMessageId || `session:${input.sessionMessageId}`,
          conversationId: input.conversationId,
          assistantId: input.assistantId,
          assistantName: input.assistantName,
          text: input.text,
          documents: input.documents,
          replyToProviderId: input.replyToProviderId,
        })],
        sourceCursor: { session_message_id: input.sessionMessageId },
      })
    },
  }
}

let globalWriter: LiveChatArchiveWriter | null = null

export function setGlobalLiveChatArchiveWriter(writer: LiveChatArchiveWriter | null): void {
  globalWriter = writer
}

export async function persistInboundChatArchive<T>(
  input: LiveArchiveContext & { message: IncomingMessage },
  persist: (client?: Queryable) => Promise<T>,
): Promise<T> {
  return globalWriter ? globalWriter.persistInbound(input, persist) : persist()
}

/**
 * Archive an inbound message that no assistant will answer.
 *
 * A no-op when the archive is not configured, which is the common case — this
 * sits on the inbound path of every channel, so it must never be the reason a
 * message is dropped.
 */
export async function archiveUnroutedInbound(input: {
  source: ChannelSource
  workspaceId: string
  conversationId: string
  message: IncomingMessage
}): Promise<void> {
  if (!globalWriter) return
  await globalWriter.appendUnroutedInbound(input)
}

export async function resolveChatArchiveInstanceId(
  input: LiveArchiveContext,
): Promise<string | null> {
  if (!globalWriter) return null
  return globalWriter.resolveInstanceId(input)
}

export async function appendInboundChatArchive(
  input: Parameters<LiveChatArchiveWriter['appendInbound']>[0],
): Promise<void> {
  if (!globalWriter) return
  await globalWriter.appendInbound(input)
}

export async function appendOutboundChatArchive(input: Parameters<LiveChatArchiveWriter['appendOutbound']>[0]): Promise<void> {
  if (!globalWriter) return
  try {
    await globalWriter.appendOutbound(input)
  } catch (err) {
    // Delivery already happened. Keep the channel available and leave the
    // persisted assistant row as the explicit repair source.
    console.warn('[chat-archive] outbound enqueue failed:', err)
  }
}
