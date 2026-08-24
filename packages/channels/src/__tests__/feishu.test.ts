import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildFeishuCard,
  createFeishuAdapter,
  feishuResourceRef,
  parseFeishuResourceRef,
  toFeishuEmojiType,
} from '../feishu/index.js'
import type { FeishuApi, FeishuNormalizedMessage } from '../feishu/index.js'

function makeApi() {
  let nextId = 0
  return {
    send: vi.fn<FeishuApi['send']>(async () => ({ messageId: `om_${++nextId}` })),
    editMessage: vi.fn<FeishuApi['editMessage']>(async () => {}),
    updateCard: vi.fn<FeishuApi['updateCard']>(async () => {}),
    recallMessage: vi.fn<FeishuApi['recallMessage']>(async () => {}),
    addReaction: vi.fn<FeishuApi['addReaction']>(async () => 'reaction_1'),
    removeReactionByEmoji: vi.fn<FeishuApi['removeReactionByEmoji']>(async () => true),
    getMessageChatId: vi.fn<FeishuApi['getMessageChatId']>(async () => 'oc_chat'),
    downloadResource: vi.fn<FeishuApi['downloadResource']>(async () => ({
      data: new Uint8Array([1, 2, 3]),
    })),
  } satisfies FeishuApi
}

function message(patch: Partial<FeishuNormalizedMessage> = {}): FeishuNormalizedMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'Alice',
    senderType: 'user',
    senderIsBot: false,
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1_700_000_000_000,
    ...patch,
  }
}

describe('[COMP:channels/feishu] inbound normalization', () => {
  let api: ReturnType<typeof makeApi>

  beforeEach(() => {
    api = makeApi()
  })

  it('accepts a DM without a mention and preserves sender identity', () => {
    const adapter = createFeishuAdapter({ api })
    expect(adapter.parseIncoming(message())).toMatchObject({
      userId: 'ou_user',
      senderDisplay: 'Alice',
      channelId: 'oc_chat',
      messageId: 'om_1',
      text: 'hello',
      isGroupChat: false,
      isMentioned: false,
      timestamp: 1_700_000_000_000,
    })
  })

  it('requires a bot mention in groups by default', () => {
    const adapter = createFeishuAdapter({ api })
    expect(adapter.parseIncoming(message({ chatType: 'group' }))).toBeNull()
    expect(adapter.parseIncoming(message({ chatType: 'group', mentionedBot: true })))
      .toMatchObject({ isGroupChat: true, isMentioned: true })
  })

  it('can defer the group mention gate to the route live config', () => {
    const adapter = createFeishuAdapter({ api, deferMentionGate: true })
    expect(adapter.parseIncoming(message({ chatType: 'group' }))).not.toBeNull()
  })

  it('drops bot senders and self echoes', () => {
    const adapter = createFeishuAdapter({ api, botOpenId: 'ou_bot' })
    expect(adapter.parseIncoming(message({ senderIsBot: true }))).toBeNull()
    expect(adapter.parseIncoming(message({ senderId: 'ou_bot' }))).toBeNull()
  })

  it('prefers thread then root then reply ids for the reply target', () => {
    const adapter = createFeishuAdapter({ api })
    expect(adapter.parseIncoming(message({
      threadId: 'omt_thread',
      rootId: 'om_root',
      replyToMessageId: 'om_parent',
    }))?.replyToMessageId).toBe('omt_thread')
    expect(adapter.parseIncoming(message({ rootId: 'om_root', replyToMessageId: 'om_parent' }))
      ?.replyToMessageId).toBe('om_root')
    expect(adapter.parseIncoming(message({ replyToMessageId: 'om_parent' }))
      ?.replyToMessageId).toBe('om_parent')
  })

  it('maps resources to opaque internal refs and media metadata', () => {
    const adapter = createFeishuAdapter({ api })
    const incoming = adapter.parseIncoming(message({
      content: '',
      resources: [{ type: 'audio', fileKey: 'file/key', fileName: 'note.ogg', durationMs: 2400 }],
    }))
    expect(incoming).toMatchObject({
      mediaType: 'voice',
      mediaMime: 'audio/*',
      mediaName: 'note.ogg',
      mediaDurationSec: 2,
      files: [{ name: 'note.ogg', mimeType: 'audio/*' }],
    })
    expect(parseFeishuResourceRef(incoming!.files![0].url)).toEqual({
      messageId: 'om_1',
      fileKey: 'file/key',
      type: 'audio',
    })
  })

  it('uses the provider message id as the durable dedup key', () => {
    const adapter = createFeishuAdapter({ api })
    expect(adapter.deduplicateId(message())).toBe('om_1')
    expect(adapter.deduplicateId({ nope: true })).toBeNull()
  })
})

describe('[COMP:channels/feishu] outbound delivery', () => {
  it('chunks markdown and preserves reply-in-topic options on every chunk', async () => {
    const api = makeApi()
    const adapter = createFeishuAdapter({ api, config: { replyInThread: true } })
    await adapter.sendMessage('oc_chat', {
      text: `${'a'.repeat(3990)}\n${'b'.repeat(40)}`,
      format: 'markdown',
    }, { threadTs: 'om_trigger' })

    expect(api.send).toHaveBeenCalledTimes(2)
    expect(api.send.mock.calls[0][1]).toHaveProperty('markdown')
    expect(api.send.mock.calls[0][2]).toEqual({
      replyTo: 'om_trigger',
      replyInThread: true,
      resolveMentionsInText: true,
    })
    expect(api.send.mock.calls[1][2]).toEqual(api.send.mock.calls[0][2])
  })

  it('sends confirmation actions as an interactive card', async () => {
    const api = makeApi()
    const adapter = createFeishuAdapter({ api })
    await adapter.sendMessage('oc_chat', {
      text: 'Run the action?',
      actions: [
        { id: 'allow', label: 'Allow', data: 'mcp_confirm:call_1:allow' },
        { id: 'deny', label: 'Deny', data: 'mcp_confirm:call_1:deny' },
      ],
    })

    const sent = api.send.mock.calls[0][1] as { card: object }
    expect(sent.card).toEqual(buildFeishuCard('Run the action?', [
      { id: 'allow', label: 'Allow', data: 'mcp_confirm:call_1:allow' },
      { id: 'deny', label: 'Deny', data: 'mcp_confirm:call_1:deny' },
    ]))
    expect(JSON.stringify(sent.card)).toContain('mcp_confirm:call_1:allow')
  })

  it('uploads documents and reports a per-file failure without failing the reply', async () => {
    const api = makeApi()
    api.send
      .mockResolvedValueOnce({ messageId: 'om_text' })
      .mockRejectedValueOnce(new Error('missing_scope'))
      .mockResolvedValueOnce({ messageId: 'om_notice' })
    const adapter = createFeishuAdapter({ api })

    await expect(adapter.sendMessage('oc_chat', {
      text: 'Here is the file.',
      documents: [{
        filename: 'report.txt',
        mime: 'text/plain',
        data: new Uint8Array([104, 105]),
      }],
    })).resolves.toBe('om_notice')

    expect(api.send.mock.calls[1][1]).toMatchObject({ file: { fileName: 'report.txt' } })
    expect(api.send.mock.calls[2][1]).toEqual({ text: 'Could not attach report.txt.' })
  })

  it('edits the first chunk and sends overflow as new reply chunks', async () => {
    const api = makeApi()
    const adapter = createFeishuAdapter({ api })
    await adapter.editMessage('oc_chat', 'om_status', {
      text: `${'x'.repeat(3995)}\n${'y'.repeat(30)}`,
      format: 'markdown',
    }, { threadTs: 'om_trigger' })
    expect(api.editMessage).toHaveBeenCalledTimes(1)
    expect(api.send).toHaveBeenCalledTimes(1)
    expect(api.send.mock.calls[0][2]).toMatchObject({ replyTo: 'om_trigger' })
  })

  it('uses editable status, recall, delete, and reactions', async () => {
    const api = makeApi()
    const adapter = createFeishuAdapter({ api })
    await expect(adapter.sendStatus('oc_chat', 'Thinking...', { threadTs: 'om_1' }))
      .resolves.toBe('om_1')
    await adapter.clearStatus?.('oc_chat', { messageId: 'om_status' })
    await adapter.deleteMessage?.('oc_chat', 'om_delete')
    await adapter.reactToMessage?.('oc_chat', 'om_1', '👀')
    expect(api.recallMessage).toHaveBeenCalledWith('om_status')
    expect(api.recallMessage).toHaveBeenCalledWith('om_delete')
    expect(api.addReaction).toHaveBeenCalledWith('om_1', 'EYES')
  })
})

describe('[COMP:channels/feishu] card and resource safety', () => {
  it('encodes callback data under a value object and link actions as URLs', () => {
    const card = buildFeishuCard('Confirm', [
      { id: 'allow', label: 'Allow', data: 'mcp_confirm:a:allow' },
      { kind: 'web_app', label: 'Open', url: 'https://example.com' },
    ])
    expect(card).toMatchObject({
      elements: [
        { tag: 'markdown', content: 'Confirm' },
        {
          tag: 'action',
          actions: [
            { type: 'primary', value: { data: 'mcp_confirm:a:allow' } },
            { type: 'default', url: 'https://example.com' },
          ],
        },
      ],
    })
  })

  it('round-trips encoded resource ids and rejects malformed refs', () => {
    const ref = feishuResourceRef('om/a', 'file key', 'file')
    expect(parseFeishuResourceRef(ref)).toEqual({
      messageId: 'om/a',
      fileKey: 'file key',
      type: 'file',
    })
    expect(parseFeishuResourceRef('https://open.feishu.cn/file')).toBeNull()
    expect(parseFeishuResourceRef('feishu-resource:a/b/not-real')).toBeNull()
  })

  it('maps common unicode and symbolic emoji forms', () => {
    expect(toFeishuEmojiType('👍')).toBe('THUMBSUP')
    expect(toFeishuEmojiType(':eyes:')).toBe('EYES')
    expect(toFeishuEmojiType('thumbs-up')).toBe('THUMBS_UP')
  })
})
