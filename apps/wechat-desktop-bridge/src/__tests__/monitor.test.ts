/**
 * [COMP:app/wechat-desktop-bridge] monitor: dirty-chat detection, ordering,
 * cursor advance, at-least-once on failure, official-account skip.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { BridgeHttpError } from '../brian-bridge-client.js'
import { silentLogger } from '../log.js'
import { createMonitor, isSkippedChat, type Monitor } from '../monitor.js'
import { emptyState, type BridgeStateFile } from '../state-file.js'
import { chat, fakeAgent, fakeBridge, msg, type FakeAgent, type FakeBridge } from './fakes.js'

let agent: FakeAgent
let bridge: FakeBridge
let state: BridgeStateFile
let stateFilePath: string

function makeMonitor(over: Partial<Parameters<typeof createMonitor>[0]> = {}): Monitor {
  return createMonitor({
    agent,
    bridge,
    state,
    stateFilePath,
    pollIntervalMs: 1,
    backfillOnFirstBoot: false,
    isLoggedIn: () => true,
    log: silentLogger,
    sleep: async () => {},
    ...over,
  })
}

beforeEach(async () => {
  agent = fakeAgent()
  bridge = fakeBridge()
  state = emptyState()
  stateFilePath = join(await mkdtemp(join(tmpdir(), 'bridge-test-')), 'state.json')
})

describe('[COMP:app/wechat-desktop-bridge] monitor', () => {
  it('seeds cursors at lastMsgLocalId on first boot without posting anything', async () => {
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 40 }), chat({ id: '1@chatroom', lastMsgLocalId: 9 })]
    agent.messages.set('wxid_example1', [msg({ localId: 39, chatId: 'wxid_example1' }), msg({ localId: 40, chatId: 'wxid_example1' })])
    await makeMonitor().tick()
    expect(bridge.inbound).toHaveLength(0)
    expect(state.cursors).toEqual({ wxid_example1: 40, '1@chatroom': 9 })
    const persisted = JSON.parse(await readFile(stateFilePath, 'utf8'))
    expect(persisted).toEqual({ version: 1, cursors: { wxid_example1: 40, '1@chatroom': 9 } })
  })

  it('with BACKFILL_ON_FIRST_BOOT a fresh chat replays from zero', async () => {
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 2 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1' }), msg({ localId: 2, chatId: 'wxid_example1' })])
    await makeMonitor({ backfillOnFirstBoot: true }).tick()
    expect(bridge.inbound.map((i) => i.message.text)).toEqual(['hello 1', 'hello 2'])
  })

  it('posts new rows exactly once, oldest first, and advances the cursor after each 2xx', async () => {
    state.cursors['wxid_example1'] = 40
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 43 })]
    agent.messages.set('wxid_example1', [
      msg({ localId: 40, chatId: 'wxid_example1' }),
      msg({ localId: 41, chatId: 'wxid_example1' }),
      msg({ localId: 42, chatId: 'wxid_example1' }),
      msg({ localId: 43, chatId: 'wxid_example1' }),
    ])
    const monitor = makeMonitor()
    await monitor.tick()
    expect(bridge.inbound.map((i) => i.message.text)).toEqual(['hello 41', 'hello 42', 'hello 43'])
    expect(state.cursors['wxid_example1']).toBe(43)
    // Not dirty any more: a second tick posts nothing.
    await monitor.tick()
    expect(bridge.inbound).toHaveLength(3)
  })

  it('a 500 from /inbound does not advance the cursor and the row is retried next tick', async () => {
    state.cursors['wxid_example1'] = 10
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 12 })]
    agent.messages.set('wxid_example1', [msg({ localId: 11, chatId: 'wxid_example1' }), msg({ localId: 12, chatId: 'wxid_example1' })])
    bridge.failInboundWith = new BridgeHttpError(500, '/inbound', 'boom')
    bridge.failInboundTimes = 1
    const monitor = makeMonitor()
    await monitor.tick()
    // First row failed: nothing posted, cursor unchanged, batch stopped.
    expect(bridge.inbound).toHaveLength(0)
    expect(state.cursors['wxid_example1']).toBe(10)
    await monitor.tick()
    expect(bridge.inbound.map((i) => i.message.text)).toEqual(['hello 11', 'hello 12'])
    expect(state.cursors['wxid_example1']).toBe(12)
  })

  it('a network error mid-batch stops at the failed row and resumes from it', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 3 })]
    agent.messages.set('wxid_example1', [1, 2, 3].map((n) => msg({ localId: n, chatId: 'wxid_example1' })))
    const monitor = makeMonitor()
    const original = bridge.postInbound.bind(bridge)
    let calls = 0
    bridge.postInbound = async (inb) => {
      calls++
      if (calls === 2) throw new Error('ECONNRESET')
      return original(inb)
    }
    await monitor.tick()
    expect(bridge.inbound.map((i) => i.message.text)).toEqual(['hello 1'])
    expect(state.cursors['wxid_example1']).toBe(1)
    await monitor.tick()
    expect(bridge.inbound.map((i) => i.message.text)).toEqual(['hello 1', 'hello 2', 'hello 3'])
  })

  it('persists a committed raw upload and retries inbound without reading WeChat bytes again', async () => {
    state.cursors.wxid_example1 = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1', type: 49, content: '' })])
    const bytes = 'document bytes'
    agent.media.set('wxid_example1:1', [{
      type: 'file', kind: 'file', status: 'ready', variant: 'original', format: 'docx', filename: 'plan.docx',
      data: Buffer.from(bytes).toString('base64'), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'),
    }])
    bridge.failInboundWith = new Error('ECONNRESET')
    bridge.failInboundTimes = 1
    const monitor = makeMonitor({ mediaStreamEnabled: true })
    await monitor.tick()
    expect(state.cursors.wxid_example1).toBe(0)
    expect(state.pendingMediaUpgrades?.wxid_example1?.[0]?.stagedMedia?.stored).toBeDefined()
    expect(agent.mediaCalls).toBe(1)
    expect(bridge.uploads).toHaveLength(1)

    // Simulate provider-local eviction after the archive already committed.
    agent.media.set('wxid_example1:1', [{
      type: 'file', kind: 'file', status: 'pending', format: 'docx', filename: 'plan.docx', recoverable: true,
    }])
    await monitor.tick()
    expect(agent.mediaCalls).toBe(1)
    expect(bridge.uploads).toHaveLength(1)
    expect(bridge.inbound).toHaveLength(1)
    expect(bridge.inbound[0]!.message.media?.[0]?.stored).toBeDefined()
    expect(state.cursors.wxid_example1).toBe(1)
  })

  it('skips official accounts but forwards File Transfer (filehelper)', async () => {
    state.cursors['gh_official1'] = 0
    state.cursors['filehelper'] = 0
    agent.chats = [chat({ id: 'gh_official1', lastMsgLocalId: 5 }), chat({ id: 'filehelper', lastMsgLocalId: 5 })]
    agent.messages.set('gh_official1', [msg({ localId: 5, chatId: 'gh_official1' })])
    agent.messages.set('filehelper', [msg({ localId: 5, chatId: 'filehelper', content: 'note to self' })])
    await makeMonitor().tick()
    // gh_ skipped, filehelper forwarded
    expect(bridge.inbound.map((i) => i.message.text)).toEqual(['note to self'])
    expect(isSkippedChat({ id: 'gh_abc', username: 'gh_abc' })).toBe(true)
    expect(isSkippedChat({ id: 'filehelper', username: 'filehelper' })).toBe(false)
    expect(isSkippedChat({ id: 'wxid_example1', username: 'wxid_example1' })).toBe(false)
  })

  it('does nothing while not logged in', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1' })])
    await makeMonitor({ isLoggedIn: () => false }).tick()
    expect(bridge.inbound).toHaveLength(0)
  })

  it('holds a pending media row before the cursor and delivers it when ready on a later tick', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1, unreadCount: 1 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1', type: 3, content: '' })])
    agent.media.set('wxid_example1:1', [
      { type: 'image', format: 'jpg', filename: 'a.jpg', status: 'pending', kind: 'image', reason: 'not_downloaded' },
      { type: 'image', format: 'jpg', filename: 'a.jpg', data: 'aGVsbG8=' },
    ])
    const monitor = makeMonitor({ mediaUpgradeEnabled: true })
    await monitor.tick()
    expect(bridge.inbound).toHaveLength(0)
    expect(state.cursors['wxid_example1']).toBe(0)
    agent.chats[0]!.unreadCount = 0
    state.pendingMediaUpgrades!.wxid_example1![0]!.nextAttemptAt = 0
    await monitor.tick()
    expect(agent.mediaCalls).toBe(2)
    expect(bridge.inbound[0]!.message.media![0]).toMatchObject({ kind: 'image', dataBase64: 'aGVsbG8=' })
    expect(state.cursors['wxid_example1']).toBe(1)
  })

  it('advances without bytes only for an explicit terminal provider reason', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1', type: 3, content: '' })])
    agent.media.set('wxid_example1:1', [{
      type: 'image', format: 'jpg', filename: 'a.jpg', status: 'unavailable', kind: 'image', reason: 'expired', recoverable: false,
    }])
    await makeMonitor().tick()
    expect(agent.mediaCalls).toBe(1)
    expect(bridge.inbound[0]!.message.text).toBe('[attachment unavailable: expired]')
    expect(state.cursors['wxid_example1']).toBe(1)
  })

  it('treats a known unsupported app subtype as a link, not a lost attachment', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1 })]
    agent.messages.set('wxid_example1', [msg({
      localId: 1, chatId: 'wxid_example1', type: 49,
      content: '<msg><appmsg><title>Some article</title></appmsg></msg>',
    })])
    agent.media.set('wxid_example1:1', [{
      type: 'unsupported', format: '', filename: '', status: 'unavailable', kind: 'unsupported',
      reason: 'unsupported', recoverable: false,
    }])
    await makeMonitor().tick()
    expect(bridge.inbound[0]!.message.text).toBe('[link] Some article')
    expect(state.cursors.wxid_example1).toBe(1)
  })

  it('on 413 re-sends the text with an [attachment too large] note', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1', type: 3, content: '' })])
    agent.media.set('wxid_example1:1', [{ type: 'image', format: 'jpg', filename: 'a.jpg', data: 'aGVsbG8=' }])
    bridge.failInboundWith = new BridgeHttpError(413, '/inbound', 'too large')
    bridge.failInboundTimes = 1
    await makeMonitor().tick()
    expect(bridge.inbound).toHaveLength(1)
    expect(bridge.inbound[0]!.message.media).toBeUndefined()
    expect(bridge.inbound[0]!.message.text).toBe('[attachment too large]')
  })

  it('with mediaUpgradeEnabled, a forwarded image thumb upgrades once the read chat serves better bytes', async () => {
    const thumbB64 = Buffer.from('thumb').toString('base64')
    const fullB64 = Buffer.from('full-size-original-bytes').toString('base64')
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1, unreadCount: 0 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1', type: 3, content: '' })])
    // forward() consumes the thumbnail; the sweep's re-fetch gets the original.
    agent.media.set('wxid_example1:1', [
      {
        type: 'image', format: 'jpg', filename: 'a.jpg', data: thumbB64,
        status: 'ready', kind: 'image', variant: 'preview', mime: 'image/jpeg', sizeBytes: 5,
        sha256: createHash('sha256').update('thumb').digest('hex'),
      },
      {
        type: 'image', format: 'jpg', filename: 'a.jpg', data: fullB64,
        status: 'ready', kind: 'image', variant: 'original', mime: 'image/jpeg', sizeBytes: 24,
        sha256: createHash('sha256').update('full-size-original-bytes').digest('hex'),
      },
    ])
    const monitor = makeMonitor({ mediaUpgradeEnabled: true, mediaStreamEnabled: true })
    await monitor.tick()
    expect(bridge.inbound).toHaveLength(1)
    state.pendingMediaUpgrades!.wxid_example1![0]!.nextAttemptAt = 0
    await monitor.tick()
    expect(agent.openedChats).toEqual(['wxid_example1'])
    expect(bridge.inbound).toHaveLength(2)
    expect(bridge.inbound[0]!.mediaUpgrade).toBeUndefined()
    expect(bridge.inbound[0]!.message.media![0]!.stored?.sha256).toBe(createHash('sha256').update('thumb').digest('hex'))
    expect(bridge.inbound[1]!.mediaUpgrade).toBe(true)
    expect(bridge.inbound[1]!.message.media![0]!.stored?.sha256).toBe(createHash('sha256').update('full-size-original-bytes').digest('hex'))
    expect(bridge.inbound[1]!.message.messageId).toBe(bridge.inbound[0]!.message.messageId)
    expect(state.pendingMediaUpgrades).toBeUndefined()
  })

  it('without the feature the sweep never opens chats and no pendings are recorded', async () => {
    state.cursors['wxid_example1'] = 0
    agent.chats = [chat({ id: 'wxid_example1', lastMsgLocalId: 1, unreadCount: 0 })]
    agent.messages.set('wxid_example1', [msg({ localId: 1, chatId: 'wxid_example1', type: 3, content: '' })])
    agent.media.set('wxid_example1:1', [{ type: 'image', format: 'jpg', filename: 'a.jpg', data: 'aGVsbG8=' }])
    await makeMonitor().tick()
    expect(agent.openedChats).toHaveLength(0)
    expect(state.pendingMediaUpgrades).toBeUndefined()
  })
})
