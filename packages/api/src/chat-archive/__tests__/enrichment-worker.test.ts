/** [COMP:brain/chat-archive-enrichment] Existing Pipeline B window routing. */

import { describe, expect, it, vi } from 'vitest'
import { createChatArchiveEnrichmentWorker, renderChatArchiveWindow } from '../enrichment-worker.js'
import type { ChatArchiveEnrichmentWindow } from '../../db/chat-archive-enrichment-store.js'

function window(): ChatArchiveEnrichmentWindow {
  return {
    id: 'window-1', workspaceId: 'workspace-1', instanceId: 'instance-1',
    ownerUserId: 'owner-1', source: 'wechat', conversationId: 'conversation-1',
    firstMessageId: 'message-1', lastMessageId: 'message-2',
    firstProviderMessageId: 'provider-1', lastProviderMessageId: 'provider-2',
    windowStart: new Date('2026-08-01T00:00:00Z'),
    windowEnd: new Date('2026-08-01T00:01:00Z'), attemptCount: 1,
    messages: [{
      id: 'message-1', providerMessageId: 'provider-1', senderId: 'wxid-a',
      senderDisplay: 'Alice', sentAt: new Date('2026-08-01T00:00:00Z'),
      direction: 'inbound', kind: 'text', bodyText: 'The launch is Friday.', mediaRef: null,
    }, {
      id: 'message-2', providerMessageId: 'provider-2', senderId: 'assistant',
      senderDisplay: 'Brian', sentAt: new Date('2026-08-01T00:01:00Z'),
      direction: 'outbound', kind: 'file', bodyText: null,
      mediaRef: { filename: 'plan.pdf', mime: 'application/pdf', size_bytes: 42 },
    }],
  }
}

describe('[COMP:brain/chat-archive-enrichment] worker', () => {
  it('renders bounded chronological sender context', () => {
    expect(renderChatArchiveWindow(window())).toContain('Alice (inbound): The launch is Friday.')
    expect(renderChatArchiveWindow(window())).toContain('Brian (outbound): [file: plan.pdf]')
  })

  it('routes a claimed window through the existing brain ingestor', async () => {
    const claimed = window()
    const store = {
      claimNext: vi.fn(async () => claimed), complete: vi.fn(async () => {}), fail: vi.fn(async () => {}),
    }
    const ingest = vi.fn(async () => ({}))
    const worker = createChatArchiveEnrichmentWorker({
      store, ingest: ingest as never, resolveAssistantId: async () => 'assistant-1',
    })
    await expect(worker.runOnce()).resolves.toBe(true)
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'owner-1', assistantId: 'assistant-1', sourceKind: 'channel_window',
      sourceRef: expect.objectContaining({
        archive_instance_id: 'instance-1',
        message_id_range: ['message-1', 'message-2'],
      }),
    }))
    expect(store.complete).toHaveBeenCalledWith('window-1')
    expect(store.fail).not.toHaveBeenCalled()
  })

  it('records a retry without changing raw messages when Pipeline B fails', async () => {
    const store = {
      claimNext: vi.fn(async () => window()), complete: vi.fn(), fail: vi.fn(async () => {}),
    }
    const worker = createChatArchiveEnrichmentWorker({
      store, ingest: vi.fn(async () => { throw new Error('model unavailable') }) as never,
      resolveAssistantId: async () => 'assistant-1',
    })
    await expect(worker.runOnce()).resolves.toBe(false)
    expect(store.fail).toHaveBeenCalledWith('window-1', 1, 'model unavailable')
    expect(store.complete).not.toHaveBeenCalled()
  })
})
