/**
 * [COMP:app/wechat-desktop-bridge] original-image upgrade: registration,
 * read-safety gate, digest comparison, mediaUpgrade re-post, give-up bounds.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { BridgeHttpError } from '../brian-bridge-client.js'
import { silentLogger } from '../log.js'
import { mapMessage, type MediaOutcome } from '../map-message.js'
import { createMediaUpgrader, sha256Base64, type MediaUpgrader } from '../media-upgrade.js'
import { emptyState, type BridgeStateFile } from '../state-file.js'
import { chat, fakeAgent, fakeBridge, msg, type FakeAgent, type FakeBridge } from './fakes.js'

const THUMB_B64 = Buffer.from('tiny-thumbnail-bytes').toString('base64')
const FULL_B64 = Buffer.from('the-much-larger-original-image-bytes').toString('base64')

let agent: FakeAgent
let bridge: FakeBridge
let state: BridgeStateFile
let persisted: number
let nowMs: number

function makeUpgrader(over: Partial<Parameters<typeof createMediaUpgrader>[0]> = {}): MediaUpgrader {
  return createMediaUpgrader({
    agent,
    bridge,
    state,
    persist: async () => {
      persisted++
    },
    enabled: true,
    log: silentLogger,
    sleep: async () => {},
    now: () => nowMs,
    ...over,
  })
}

/** Register one forwarded image row (thumbnail bytes) for wxid_example1:7. */
function registerThumb(upgrader: MediaUpgrader, over: { dataBase64?: string | null } = {}): void {
  const row = msg({ localId: 7, chatId: 'wxid_example1', type: 3, content: '' })
  const media: MediaOutcome =
    over.dataBase64 === null
      ? { status: 'unavailable' }
      : {
          status: 'fetched',
          result: { type: 'image', data: over.dataBase64 ?? THUMB_B64, format: 'jpeg', filename: 'msg_7.jpg' },
        }
  const mapped = mapMessage(row, chat({ id: 'wxid_example1' }), media)!
  upgrader.register({ chatId: 'wxid_example1', msg: row, mapped })
}

beforeEach(() => {
  agent = fakeAgent()
  bridge = fakeBridge()
  state = emptyState()
  persisted = 0
  nowMs = 1_000_000
})

describe('[COMP:app/wechat-desktop-bridge] media upgrade', () => {
  it('registers image rows without their bytes and records the forwarded digest', () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    const entries = state.pendingMediaUpgrades?.['wxid_example1']
    expect(entries).toHaveLength(1)
    expect(entries![0]!.localId).toBe(7)
    expect(entries![0]!.message.media).toBeUndefined()
    expect(entries![0]!.forwardedSha256).toBe(sha256Base64(THUMB_B64))
  })

  it('ignores non-image rows and does nothing when disabled', () => {
    const upgrader = makeUpgrader()
    const textRow = msg({ localId: 8, chatId: 'wxid_example1', type: 1 })
    upgrader.register({ chatId: 'wxid_example1', msg: textRow, mapped: mapMessage(textRow, chat({ id: 'wxid_example1' }))! })
    expect(state.pendingMediaUpgrades).toBeUndefined()

    const disabled = makeUpgrader({ enabled: false })
    registerThumb(disabled)
    expect(state.pendingMediaUpgrades).toBeUndefined()
  })

  it('never opens a chat the owner has not read (unreadCount > 0)', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 2 })])
    expect(agent.openedChats).toHaveLength(0)
    expect(state.pendingMediaUpgrades?.['wxid_example1']).toHaveLength(1)
  })

  it('opens a read chat, re-fetches, and re-posts changed bytes as mediaUpgrade', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    agent.media.set('wxid_example1:7', [{ type: 'image', data: FULL_B64, format: 'jpeg', filename: 'msg_7.jpg' }])
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(agent.openedChats).toEqual(['wxid_example1'])
    expect(bridge.inbound).toHaveLength(1)
    expect(bridge.inbound[0]!.mediaUpgrade).toBe(true)
    expect(bridge.inbound[0]!.message.messageId).toBe('1000007')
    expect(bridge.inbound[0]!.message.media?.[0]?.dataBase64).toBe(FULL_B64)
    expect(state.pendingMediaUpgrades?.['wxid_example1']).toBeUndefined()
    expect(persisted).toBeGreaterThan(0)
  })

  it('an unavailable original (no bytes forwarded) upgrades on the first fetched bytes', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader, { dataBase64: null })
    agent.media.set('wxid_example1:7', [{ type: 'image', data: FULL_B64, format: 'jpeg', filename: 'msg_7.jpg' }])
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(bridge.inbound).toHaveLength(1)
    expect(bridge.inbound[0]!.mediaUpgrade).toBe(true)
  })

  it('unchanged bytes count an attempt; the entry drops after 4 attempts', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    agent.media.set('wxid_example1:7', [{ type: 'image', data: THUMB_B64, format: 'jpeg', filename: 'msg_7.jpg' }])
    const chats = [chat({ id: 'wxid_example1', unreadCount: 0 })]
    for (let i = 0; i < 4; i++) await upgrader.sweep(chats)
    expect(bridge.inbound).toHaveLength(0)
    expect(state.pendingMediaUpgrades?.['wxid_example1']).toBeUndefined()
    // Exactly 4 opens: the exhausted entry stops the chat from being swept.
    expect(agent.openedChats).toHaveLength(4)
    await upgrader.sweep(chats)
    expect(agent.openedChats).toHaveLength(4)
  })

  it('a failed open counts an attempt for every entry in the chat', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    agent.openResult = { ok: false, error: 'NOT_LOGGED_IN' }
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(state.pendingMediaUpgrades?.['wxid_example1']![0]!.attempts).toBe(1)
    expect(agent.mediaCalls).toBe(0)
  })

  it('a 4xx on the upgrade post drops the entry; a 5xx keeps it without an attempt', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    agent.media.set('wxid_example1:7', [{ type: 'image', data: FULL_B64, format: 'jpeg', filename: 'msg_7.jpg' }])
    bridge.failInboundWith = new BridgeHttpError(500, '/inbound', 'boom')
    bridge.failInboundTimes = 1
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(state.pendingMediaUpgrades?.['wxid_example1']![0]!.attempts).toBe(0)

    bridge.failInboundWith = new BridgeHttpError(413, '/inbound', 'too large')
    bridge.failInboundTimes = 1
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(state.pendingMediaUpgrades?.['wxid_example1']).toBeUndefined()
    expect(bridge.inbound).toHaveLength(0)
  })

  it('expires entries older than 72 h without opening anything', async () => {
    const upgrader = makeUpgrader()
    registerThumb(upgrader)
    nowMs += 73 * 60 * 60 * 1000
    await upgrader.sweep([chat({ id: 'wxid_example1', unreadCount: 0 })])
    expect(agent.openedChats).toHaveLength(0)
    expect(state.pendingMediaUpgrades?.['wxid_example1']).toBeUndefined()
  })

  it('caps pendings per chat at 20, dropping the oldest', () => {
    const upgrader = makeUpgrader()
    for (let i = 1; i <= 25; i++) {
      const row = msg({ localId: i, chatId: 'wxid_example1', type: 3, content: '' })
      const mapped = mapMessage(row, chat({ id: 'wxid_example1' }), {
        status: 'fetched',
        result: { type: 'image', data: THUMB_B64, format: 'jpeg', filename: `msg_${i}.jpg` },
      })!
      upgrader.register({ chatId: 'wxid_example1', msg: row, mapped })
    }
    const entries = state.pendingMediaUpgrades?.['wxid_example1']
    expect(entries).toHaveLength(20)
    expect(entries![0]!.localId).toBe(6)
  })
})
