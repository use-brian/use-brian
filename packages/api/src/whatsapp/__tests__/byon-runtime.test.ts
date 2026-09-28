import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WhatsappBotInput } from '../../routes/whatsapp-bot-handler.js'
import type { BotChannelContext } from '../../routes/whatsapp-bot-wiring.js'

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => 'out'),
  createBot: vi.fn(),
  query: vi.fn(async () => ({ rows: [{ acquired: true }] })),
}))
vi.mock('@use-brian/channels', () => ({ createWhatsAppAdapter: () => ({ sendMessage: mocks.sendMessage }) }))
vi.mock('../../ingest/whatsapp-ingest.js', () => ({ createWhatsappIngestor: () => ({}) }))
vi.mock('../../routes/whatsapp-bot-wiring.js', () => ({ createWhatsappBot: mocks.createBot }))
vi.mock('../../db/client.js', () => ({ query: mocks.query }))

import { createWhatsappByonRuntime, type WhatsappByonRuntimeDeps } from '../byon-runtime.js'
import { resolveWhatsappByonTurnIdentity } from '../byon-identity.js'
import { channelConfirmations } from '../../routes/channel-interactions.js'

const input: WhatsappBotInput = {
  channelId: 'platform-channel', chatJid: 'group@g.us', senderJid: 'alice@lid', senderPnJid: 'alice@s.whatsapp.net',
  messageId: 'in', text: 'approve', isGroup: true,
} as WhatsappBotInput
const ctx = { assistantId: 'assistant' } as BotChannelContext

function setup(implementation: WhatsappByonRuntimeDeps['runPipeline'] = async () => {}) {
  const runPipeline = vi.fn(implementation)
  createWhatsappByonRuntime({ runPipeline } as never)
  const options = mocks.createBot.mock.lastCall![0] as { runAssistant: (ctx: BotChannelContext, input: WhatsappBotInput) => Promise<void> }
  return { runPipeline, runAssistant: options.runAssistant }
}

beforeEach(() => { vi.clearAllMocks() })

describe('BYON shared confirmations', () => {
  it('isolates sender and platform channel, then consumes before entering the pipeline', async () => {
    const { runPipeline, runAssistant } = setup()
    const resolver = { resolve: vi.fn() }
    const dispose = channelConfirmations.register({
      channelType: 'whatsapp', integrationId: input.channelId, conversationId: input.chatJid, senderId: input.senderPnJid!,
    }, { toolCallId: 'byon-confirm', toolName: 'sendEmail', input: {}, allowPersistentApproval: false } as never, resolver as never)
    try {
      await runAssistant(ctx, { ...input, senderJid: 'bob@lid', senderPnJid: 'bob@s.whatsapp.net' })
      await runAssistant(ctx, { ...input, channelId: 'another-channel' })
      expect(resolver.resolve).not.toHaveBeenCalled()
      runPipeline.mockClear()
      await runAssistant(ctx, input)
      expect(resolver.resolve).toHaveBeenCalledWith('byon-confirm', 'allow', undefined)
      expect(runPipeline).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it('passes documents and action metadata through response hooks', async () => {
    const { runPipeline, runAssistant } = setup()
    await runAssistant(ctx, { ...input, text: 'Hello' })
    const hooks = runPipeline.mock.lastCall![0].hooks
    const documents = [{ filename: 'a.txt', mime: 'text/plain', data: new Uint8Array([65]) }]
    const actions = [{ id: '0', label: 'Alpha', data: 'ask:token:0', replyText: 'Alpha' }]
    await hooks.sendResponse('', documents, undefined, actions)
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(input.chatJid, { text: '', documents, actions })
    await hooks.onConfirmationRequired?.({ toolCallId: 'byon-prompt', toolName: 'sendEmail', input: {}, description: 'Send mail', allowPersistentApproval: false } as never, {} as never)
    expect(mocks.sendMessage).toHaveBeenLastCalledWith(input.chatJid, expect.objectContaining({
      text: expect.stringContaining('Send mail'), actions: expect.any(Array),
    }))
  })
  it('serializes the entire interactive turn by connection and chat, not sender', async () => {
    let release!: () => void
    const blocked = new Promise<void>(r => { release = r })
    const entered: string[] = []
    const { runAssistant } = setup(async ({ input: event }) => {
      entered.push(event.messageId)
      if (event.messageId === 'first') await blocked
    })
    const first = runAssistant(ctx, { ...input, text: 'first', messageId: 'first' })
    await vi.waitFor(() => expect(entered).toEqual(['first']))
    const second = runAssistant(ctx, { ...input, senderJid: 'other@lid', senderPnJid: 'other@s.whatsapp.net', text: 'second', messageId: 'second' })
    const otherConnection = runAssistant(ctx, { ...input, channelId: 'another-connection', text: 'third', messageId: 'third' })
    const otherChat = runAssistant(ctx, { ...input, chatJid: 'another@g.us', text: 'fourth', messageId: 'fourth' })
    try {
      await Promise.all([otherConnection, otherChat])
      expect(entered).toEqual(['first', 'third', 'fourth'])
      expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO chat_turn_locks'),
        [expect.stringContaining(JSON.stringify([input.channelId, input.chatJid])), expect.any(String), expect.any(String)])
    } finally { release(); await Promise.all([first, second]) }
    expect(entered).toEqual(['first', 'third', 'fourth', 'second'])
  })

  it('lets a confirmation reply resume a turn while its chat lock is still held', async () => {
    let resume!: () => void
    const suspended = new Promise<void>(r => { resume = r })
    const resolve = vi.fn(() => resume())
    let dispose = () => {}
    const { runAssistant, runPipeline } = setup(async () => {
      dispose = channelConfirmations.register({
        channelType: 'whatsapp', integrationId: input.channelId, conversationId: input.chatJid, senderId: input.senderPnJid!,
      }, { toolCallId: 'locked-confirmation', toolName: 'sendEmail', input: {}, allowPersistentApproval: false } as never, { resolve } as never)
      await suspended
    })
    const turn = runAssistant(ctx, { ...input, text: 'send email' })
    try {
      await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledOnce())
      await runAssistant(ctx, input)
      await turn
      expect(resolve).toHaveBeenCalledExactlyOnceWith('locked-confirmation', 'allow', undefined)
      expect(runPipeline).toHaveBeenCalledOnce()
    } finally { dispose(); resume(); await turn }
  })

  it('releases the turn lock after identity resolution fails', async () => {
    const { runAssistant, runPipeline } = setup()
    runPipeline.mockRejectedValueOnce(new Error('identity unavailable'))
    await expect(runAssistant(ctx, input)).rejects.toThrow('identity unavailable')
    await runAssistant(ctx, input)
    expect(runPipeline).toHaveBeenCalledTimes(2)
  })

  it('composes the same sender-scoped identity used by boot under the runtime lock', async () => {
    const pipeline = vi.fn()
    const linked = vi.fn(async () => ({ userId: 'linked-sender' }))
    const shadow = vi.fn()
    const { runAssistant } = setup(async ({ input: event, ctx: channel }) => {
      const identity = await resolveWhatsappByonTurnIdentity(event, channel.assistantId!, {
        findLinkedAccount: linked, findUser: async id => ({ id }), resolveShadow: shadow,
      })
      pipeline({ ...identity, ownerId: channel.ownerUserId })
    })
    await runAssistant({ ...ctx, ownerUserId: 'owner' }, {
      ...input, senderJid: '12345678@lid', senderPnJid: '15551234567@s.whatsapp.net', text: 'approve abc123',
    })
    expect(pipeline).toHaveBeenCalledExactlyOnceWith({
      ownerId: 'owner', userId: 'linked-sender', isIdentified: true, actorChannelId: '15551234567@s.whatsapp.net',
      interactionScope: { channelType: 'whatsapp', integrationId: input.channelId, conversationId: input.chatJid, senderId: '15551234567@s.whatsapp.net' },
    })
    expect(shadow).not.toHaveBeenCalled()
    expect(linked).toHaveBeenCalledWith('whatsapp', '15551234567')
  })

})
