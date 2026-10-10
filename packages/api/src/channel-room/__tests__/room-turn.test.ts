import { describe, expect, it } from 'vitest'
import { roomTurnShape, type RoomTurnFacts } from '../turn.js'
import { roomDisclosureText, roomSpeakerLabel, formatProviderHistory } from '../room.js'
import { classifySession, policyFor, ROOM_TRANSPORTS, sessionPolicy, transportPolicy } from '../../session-kind.js'

/**
 * Unified-sessions §4.4 / §9 S4: a converged group is one workspace room on
 * every transport. These cases grade the per-turn decisions the channel
 * pipeline reads from `roomTurnShape`, once per transport in the §5 order.
 */
const member: RoomTurnFacts = {
  inRoom: true, isGroupChat: true, senderIsWorkspaceMember: true,
  senderLinkedIdentity: true, externalGuest: false, memberMode: 'member',
}
const guest: RoomTurnFacts = {
  inRoom: true, isGroupChat: true, senderIsWorkspaceMember: false,
  senderLinkedIdentity: false, externalGuest: true, memberMode: 'external',
}

describe('[COMP:api/channel-room] room turns per transport', () => {
  for (const transport of ROOM_TRANSPORTS) {
    describe(transport, () => {
      const room = { channelType: transport, anchorKind: 'channel', visibility: 'workspace', channelId: '-100' }

      it('converges groups on this transport into a workspace room', () => {
        expect(transportPolicy(transport).rooms.converge).toBe(true)
        const kind = classifySession(room)
        expect(kind).toMatchObject({ audience: 'workspace', anchor: { kind: 'channel' }, transport })
      })

      it('is one room every sender shares: room admission, mention addressing, attribution', () => {
        const policy = policyFor(room)
        expect(policy.admission).toBe('room')
        expect(policy.addressing).toBe('mention')
        expect(policy.attribution).toBe(true)
        expect(policy.confirmations).toBe('addresser_or_admin')
        expect(policy.billing).toBe('workspace')
        // The reply belongs in the group, so the web composer never runs it.
        expect(policy.webTurns).toBe(false)
      })

      it('never loads the addresser\'s personal memory (D3)', () => {
        expect(sessionPolicy(classifySession(room)).context.personalMemory).toBe(false)
        expect(roomTurnShape(member).groupSpeaker).toBe(false)
        // The per-user group path it replaces did load it for a linked member.
        expect(roomTurnShape({ ...member, inRoom: false }).groupSpeaker).toBe(true)
      })

      it('answers a guest at the room\'s clearance and writes no memory for them (D1)', () => {
        const shape = roomTurnShape(guest)
        expect(shape.externalGuest).toBe(false)
        expect(shape.memberMode).toBe('assistant')
        expect(shape.memoryWrites).toBe(false)
        // A member still saves memories in the room.
        expect(roomTurnShape(member).memoryWrites).toBe(true)
        // Outside a room the guest keeps the isolated guest lane.
        expect(roomTurnShape({ ...guest, inRoom: false }).externalGuest).toBe(true)
      })

      it('assembles one coalesced turn from the room transcript', () => {
        const shape = roomTurnShape(member)
        expect(shape.coalesce).toBe(true)
        expect(shape.attributeSenders).toBe(true)
      })
    })
  }

  it('discloses mentions-only capture where the bot only sees mentions (Telegram privacy mode)', () => {
    expect(roomDisclosureText({ assistantName: 'Brian', channelType: 'telegram' })).toMatch(/only see messages that mention me/)
    expect(roomDisclosureText({ assistantName: 'Brian', channelType: 'slack' })).toMatch(/read every message here/)
    for (const transport of ROOM_TRANSPORTS) {
      expect(roomDisclosureText({ assistantName: 'Brian', channelType: transport })).not.toContain('—')
    }
  })

  it('labels guests by their platform handle', () => {
    expect(roomSpeakerLabel(null, '@casey')).toBe('@casey')
    expect(roomSpeakerLabel('Casey Example', '@casey')).toBe('Casey Example')
    expect(roomSpeakerLabel('  ', null)).toBeNull()
  })

  it('formats provider history once, bounded, without the triggering message', () => {
    const text = formatProviderHistory({
      transportLabel: 'Discord channel',
      messages: [
        { id: '1', at: 't1', speaker: 'Ana', text: 'first' },
        { id: '2', at: 't2', speaker: 'Bo', text: 'the mention itself' },
      ],
      excludeId: '2',
    })
    expect(text).toContain('Ana: first')
    expect(text).not.toContain('the mention itself')
    expect(formatProviderHistory({ transportLabel: 'x', messages: [] })).toBeNull()
  })

  it('keeps transports without group rooms on their own path', () => {
    expect(transportPolicy('wechat').rooms.converge).toBe(false)
    expect(transportPolicy('web').rooms.converge).toBe(false)
  })
})
