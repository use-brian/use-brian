/**
 * Unit tests for `recordSeenWhatsappGroup` — the seenChats merge that backs
 * the WhatsApp enable list + connected-number-presence eligibility.
 *
 * [COMP:api/whatsapp-seen-groups]
 */

import { describe, it, expect, vi } from 'vitest'
import {
  recordSeenWhatsappGroup,
  recordRosteredWhatsappGroups,
} from '../whatsapp-seen-groups.js'
import type { ChannelIntegrationConfig } from '@use-brian/api/db/channel-integrations.js'

const INTEGRATION_ID = 'cint_wa_1'
const GROUP = '120363000000000000@g.us'

/**
 * A `mergeConfigSystem` stub over an in-memory config: runs the mutator and
 * captures the result so a test can assert what was written.
 */
function makeStore(initial: ChannelIntegrationConfig = {}) {
  let config = initial
  const mergeConfigSystem = vi.fn(
    async (_id: string, mutate: (c: ChannelIntegrationConfig) => ChannelIntegrationConfig) => {
      config = mutate(config)
      return { id: _id } as never
    },
  )
  return { store: { mergeConfigSystem }, get config() { return config }, mergeConfigSystem }
}

describe('[COMP:api/whatsapp-seen-groups] recordSeenWhatsappGroup', () => {
  it('adds a new group entry (forum-free, no topics)', async () => {
    const s = makeStore()
    await recordSeenWhatsappGroup(s.store as never, {
      channelIntegrationId: INTEGRATION_ID,
      chatJid: GROUP,
      subject: 'Team Ops',
    })
    expect(s.config.seenChats).toHaveLength(1)
    expect(s.config.seenChats![0]).toMatchObject({
      chatId: GROUP,
      chatTitle: 'Team Ops',
      isForum: false,
      topics: [],
    })
    expect(typeof s.config.seenChats![0].lastSeenAt).toBe('string')
  })

  it('records the JID with a null title when no subject is supplied', async () => {
    const s = makeStore()
    await recordSeenWhatsappGroup(s.store as never, {
      channelIntegrationId: INTEGRATION_ID,
      chatJid: GROUP,
    })
    expect(s.config.seenChats![0]).toMatchObject({ chatId: GROUP, chatTitle: null })
  })

  it('backfills a title learned later for an already-seen group', async () => {
    const s = makeStore({
      seenChats: [
        { chatId: GROUP, chatTitle: null, isForum: false, topics: [], lastSeenAt: new Date().toISOString() },
      ],
    })
    await recordSeenWhatsappGroup(s.store as never, {
      channelIntegrationId: INTEGRATION_ID,
      chatJid: GROUP,
      subject: 'Renamed Group',
    })
    expect(s.config.seenChats).toHaveLength(1)
    expect(s.config.seenChats![0].chatTitle).toBe('Renamed Group')
  })

  it('is a no-op (returns the unchanged config) for a fresh, title-stable re-sighting', async () => {
    const recent = new Date().toISOString()
    const s = makeStore({
      seenChats: [
        { chatId: GROUP, chatTitle: 'Team Ops', isForum: false, topics: [], lastSeenAt: recent },
      ],
    })
    await recordSeenWhatsappGroup(s.store as never, {
      channelIntegrationId: INTEGRATION_ID,
      chatJid: GROUP,
      subject: 'Team Ops',
    })
    // lastSeenAt unchanged — nothing new learned within the throttle window.
    expect(s.config.seenChats![0].lastSeenAt).toBe(recent)
  })

  it('does not clobber other seen groups when recording a new one', async () => {
    const other = '120363999999999999@g.us'
    const s = makeStore({
      seenChats: [
        { chatId: other, chatTitle: 'Other', isForum: false, topics: [], lastSeenAt: new Date().toISOString() },
      ],
    })
    await recordSeenWhatsappGroup(s.store as never, {
      channelIntegrationId: INTEGRATION_ID,
      chatJid: GROUP,
      subject: 'Team Ops',
    })
    expect(s.config.seenChats!.map((c) => c.chatId).sort()).toEqual([GROUP, other].sort())
  })
})

const EPOCH = new Date(0).toISOString()

describe('[COMP:api/whatsapp-seen-groups] recordRosteredWhatsappGroups', () => {
  it('adds new rostered groups with an epoch lastSeenAt sentinel (sorts after active groups)', async () => {
    const s = makeStore()
    await recordRosteredWhatsappGroups(s.store as never, INTEGRATION_ID, [
      { jid: GROUP, subject: 'Team Ops' },
      { jid: '120363111111111111@g.us', subject: 'Random' },
    ])
    expect(s.config.seenChats).toHaveLength(2)
    expect(s.config.seenChats![0]).toMatchObject({
      chatId: GROUP,
      chatTitle: 'Team Ops',
      isForum: false,
      topics: [],
      lastSeenAt: EPOCH,
    })
  })

  it('never overwrites the real lastSeenAt of an already message-active group', async () => {
    const recent = new Date().toISOString()
    const s = makeStore({
      seenChats: [
        { chatId: GROUP, chatTitle: 'Team Ops', isForum: false, topics: [], lastSeenAt: recent },
      ],
    })
    await recordRosteredWhatsappGroups(s.store as never, INTEGRATION_ID, [
      { jid: GROUP, subject: 'Team Ops' },
    ])
    // Existing recency stamp preserved — roster presence must not look like activity.
    expect(s.config.seenChats![0].lastSeenAt).toBe(recent)
  })

  it('backfills a title for an existing entry without touching lastSeenAt', async () => {
    const s = makeStore({
      seenChats: [
        { chatId: GROUP, chatTitle: null, isForum: false, topics: [], lastSeenAt: EPOCH },
      ],
    })
    await recordRosteredWhatsappGroups(s.store as never, INTEGRATION_ID, [
      { jid: GROUP, subject: 'Named Now' },
    ])
    expect(s.config.seenChats![0]).toMatchObject({ chatTitle: 'Named Now', lastSeenAt: EPOCH })
  })

  it('is a no-op (no write) for an empty roster', async () => {
    const s = makeStore()
    await recordRosteredWhatsappGroups(s.store as never, INTEGRATION_ID, [])
    expect(s.mergeConfigSystem).not.toHaveBeenCalled()
  })

  it('returns the config unchanged when every rostered group is already known', async () => {
    const s = makeStore({
      seenChats: [
        { chatId: GROUP, chatTitle: 'Team Ops', isForum: false, topics: [], lastSeenAt: EPOCH },
      ],
    })
    await recordRosteredWhatsappGroups(s.store as never, INTEGRATION_ID, [
      { jid: GROUP, subject: 'Team Ops' },
    ])
    // Same single entry, unchanged — the durable inventory only grows.
    expect(s.config.seenChats).toHaveLength(1)
    expect(s.config.seenChats![0].lastSeenAt).toBe(EPOCH)
  })
})
