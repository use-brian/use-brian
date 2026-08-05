/** Routes raw archive windows through the existing platform Pipeline B seam. */

import type { BrainEpisodeIngestor } from '../ingest-port.js'
import type {
  ChatArchiveEnrichmentStore,
  ChatArchiveEnrichmentWindow,
} from '../db/chat-archive-enrichment-store.js'

export function renderChatArchiveWindow(window: ChatArchiveEnrichmentWindow): string {
  return window.messages.map((message) => {
    const sender = message.senderDisplay || message.senderId || 'unknown'
    const body = message.bodyText?.trim() || [
      `[${message.kind}`,
      message.mediaRef?.filename ? `: ${message.mediaRef.filename}` : '',
      ']',
    ].join('')
    return `[${message.sentAt.toISOString()}] ${sender} (${message.direction}): ${body.slice(0, 2000)}`
  }).join('\n').slice(0, 16_000)
}

export type ChatArchiveEnrichmentWorker = {
  runOnce(): Promise<boolean>
  start(): void
  stop(): void
}

export function createChatArchiveEnrichmentWorker(deps: {
  store: ChatArchiveEnrichmentStore
  ingest: BrainEpisodeIngestor
  resolveAssistantId: (workspaceId: string) => Promise<string | null>
  intervalMs?: number
}): ChatArchiveEnrichmentWorker {
  const intervalMs = deps.intervalMs ?? 30_000
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  const runOnce = async (): Promise<boolean> => {
    if (running) return false
    running = true
    let window: ChatArchiveEnrichmentWindow | null = null
    try {
      window = await deps.store.claimNext()
      if (!window) return false
      const assistantId = await deps.resolveAssistantId(window.workspaceId)
      if (!assistantId) throw new Error('no primary assistant for archive workspace')
      const content = renderChatArchiveWindow(window)
      if (!content.trim()) throw new Error('archive window has no enrichable content')
      await deps.ingest({
        workspaceId: window.workspaceId,
        userId: window.ownerUserId,
        assistantId,
        content,
        occurredAt: window.windowStart,
        sourceLabel: `${window.source} chat history`,
        sourceKind: 'channel_window',
        sourceRef: {
          source_kind: 'channel_window',
          archive_instance_id: window.instanceId,
          conversation_id: window.conversationId,
          message_id_range: [window.firstMessageId, window.lastMessageId],
          provider_message_id_range: [
            window.firstProviderMessageId,
            window.lastProviderMessageId,
          ],
        },
        contentRef: {
          source_kind: 'channel_window',
          archive_instance_id: window.instanceId,
          conversation_id: window.conversationId,
          message_id_range: [window.firstMessageId, window.lastMessageId],
        },
      })
      await deps.store.complete(window.id)
      return true
    } catch (err) {
      if (window) {
        await deps.store.fail(
          window.id,
          window.attemptCount,
          err instanceof Error ? err.message : String(err),
        ).catch(() => {})
      }
      console.warn('[chat-archive] enrichment failed:', err)
      return false
    } finally {
      running = false
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return
      timer = setInterval(() => void runOnce(), intervalMs)
      timer.unref?.()
      void runOnce()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
