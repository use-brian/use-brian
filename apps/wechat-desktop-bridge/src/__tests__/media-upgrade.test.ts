/**
 * [COMP:app/wechat-desktop-bridge] durable all-media recovery: persistence,
 * read-safety, pending-to-ready, preview upgrade, terminal state and backoff.
 */
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { silentLogger } from '../log.js'
import { mapMessage, type MediaOutcome } from '../map-message.js'
import { createMediaUpgrader, type MediaUpgrader } from '../media-upgrade.js'
import { emptyState, type BridgeStateFile } from '../state-file.js'
import type { AgentWechatMediaResult } from '../agent-wechat-client.js'
import { chat, fakeAgent, fakeBridge, msg, type FakeAgent, type FakeBridge } from './fakes.js'

let agent: FakeAgent
let bridge: FakeBridge
let state: BridgeStateFile
let persisted: number
let nowMs: number

function ready(bytes: string, variant: 'preview' | 'original' = 'original'): AgentWechatMediaResult {
  const data = Buffer.from(bytes).toString('base64')
  return {
    type: 'image', kind: 'image', status: 'ready', variant,
    data, format: 'jpeg', filename: 'msg_7.jpg', mime: 'image/jpeg',
    sizeBytes: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function pending(kind: 'image' | 'file' | 'video' | 'voice' = 'image'): AgentWechatMediaResult {
  return {
    type: kind, kind, status: 'pending', format: '', filename: kind === 'file' ? 'plan.docx' : '',
    reason: 'not_downloaded', action: kind === 'file' ? 'click_file' : 'open_chat', recoverable: true,
  }
}

function makeUpgrader(over: Partial<Parameters<typeof createMediaUpgrader>[0]> = {}): MediaUpgrader {
  return createMediaUpgrader({
    agent,
    bridge,
    state,
    persist: async () => { persisted++ },
    enabled: true,
    mediaStreamEnabled: true,
    log: silentLogger,
    now: () => nowMs,
    ...over,
  })
}

function register(upgrader: MediaUpgrader, result: AgentWechatMediaResult, delivered: boolean): void {
  const row = msg({ localId: 7, chatId: 'wxid_example1', type: result.kind === 'file' ? 49 : 3, content: '' })
  const outcome: MediaOutcome = result.status === 'pending'
    ? { status: 'pending', result }
    : { status: 'fetched', result }
  const mapped = mapMessage(row, chat({ id: 'wxid_example1' }), outcome)!
  upgrader.defer({
    chatId: 'wxid_example1',
    msg: row,
    message: mapped,
    result,
    delivered,
    forwardedSha256: delivered ? result.sha256 ?? null : null,
  })
}

beforeEach(() => {
  agent = fakeAgent()
  bridge = fakeBridge()
  state = emptyState()
  persisted = 0
  nowMs = 1_000_000
})

describe('[COMP:app/wechat-desktop-bridge] durable media recovery', () => {
  it('records an undelivered file without bytes so restart-safe state can hold the cursor', () => {
    const upgrader = makeUpgrader()
    register(upgrader, pending('file'), false)
    expect(state.pendingMediaUpgrades?.wxid_example1?.[0]).toMatchObject({
      localId: 7,
      kind: 'file',
      delivered: false,
      forwardedSha256: null,
      attempts: 0,
      nextAttemptAt: nowMs + 2_000,
    })
  })

  it('never materializes a chat the owner has not read', async () => {
    const upgrader = makeUpgrader()
    register(upgrader, pending('file'), false)
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 2 })])
    expect(agent.openedChats).toHaveLength(0)
    expect(state.pendingMediaUpgrades?.wxid_example1).toHaveLength(1)
  })

  it('leaves an undelivered row to the cursor-owning monitor instead of double-delivering it', async () => {
    const upgrader = makeUpgrader()
    register(upgrader, pending(), false)
    agent.media.set('wxid_example1:7', [ready('original')])
    nowMs += 2_000
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(agent.openedChats).toHaveLength(0)
    expect(bridge.inbound).toHaveLength(0)
    expect(state.pendingMediaUpgrades?.wxid_example1).toHaveLength(1)
  })

  it('streams an original over the same message id after a delivered preview', async () => {
    const upgrader = makeUpgrader()
    register(upgrader, ready('thumb', 'preview'), true)
    agent.media.set('wxid_example1:7', [ready('original')])
    nowMs += 2_000
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(bridge.uploads).toHaveLength(1)
    expect(bridge.uploads[0]!.bytes.toString()).toBe('original')
    expect(bridge.inbound[0]).toMatchObject({ mediaUpgrade: true, message: { messageId: '1000007' } })
    expect(bridge.inbound[0]!.message.media?.[0]?.stored?.sha256).toBe(ready('original').sha256)
    expect(state.pendingMediaUpgrades?.wxid_example1).toBeUndefined()
  })

  it('retries a committed archive upgrade without asking WeChat for the bytes again', async () => {
    const upgrader = makeUpgrader()
    register(upgrader, ready('thumb', 'preview'), true)
    agent.media.set('wxid_example1:7', [ready('original')])
    bridge.failInboundWith = new Error('ECONNRESET')
    bridge.failInboundTimes = 1
    nowMs += 2_000
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(bridge.uploads).toHaveLength(1)
    expect(agent.mediaCalls).toBe(1)
    expect(state.pendingMediaUpgrades?.wxid_example1?.[0]?.stagedMedia?.stored).toBeDefined()

    agent.media.set('wxid_example1:7', [pending()])
    nowMs = state.pendingMediaUpgrades!.wxid_example1![0]!.nextAttemptAt
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(agent.mediaCalls).toBe(1)
    expect(bridge.uploads).toHaveLength(1)
    expect(bridge.inbound).toHaveLength(1)
    expect(state.pendingMediaUpgrades).toBeUndefined()
  })

  it('does not expire a recoverable row; unchanged state advances persisted backoff', async () => {
    const upgrader = makeUpgrader()
    register(upgrader, pending(), true)
    agent.media.set('wxid_example1:7', [pending()])
    nowMs += 365 * 24 * 60 * 60 * 1_000
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    const entry = state.pendingMediaUpgrades?.wxid_example1?.[0]
    expect(entry?.attempts).toBe(1)
    expect(entry?.nextAttemptAt).toBeGreaterThan(nowMs)
    expect(persisted).toBeGreaterThan(0)
  })

  it('removes work only when the runtime reports a terminal reason', async () => {
    const upgrader = makeUpgrader()
    register(upgrader, pending('file'), true)
    agent.media.set('wxid_example1:7', [{
      type: 'file', kind: 'file', status: 'unavailable', format: 'docx', filename: 'plan.docx',
      reason: 'expired', recoverable: false,
    }])
    nowMs += 2_000
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(state.pendingMediaUpgrades?.wxid_example1).toBeUndefined()
  })
})
