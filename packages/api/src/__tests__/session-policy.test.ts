import { describe, expect, it } from 'vitest'
import { isAttendedTurn } from '@use-brian/core'
import { feedAnchoredRead, policyFor, sessionKindSql, transportPolicy, type SessionKindRow } from '../session-kind.js'

/**
 * One case per drift row of docs/plans/unified-sessions.md section 2.2.
 * Each case asserts the policy's answer for the row; S1 flips a case in the
 * same commit that converges the row.
 */
const ROOM: SessionKindRow = { channelType: 'web', visibility: 'workspace', appOrigin: 'chat', channelId: 'r' }
const PERSONAL: SessionKindRow = { channelType: 'web', visibility: 'owner', appOrigin: 'chat', channelId: 'p' }
const DRAFT: SessionKindRow = { channelType: 'web', visibility: 'workspace', mode: 'draft', channelId: 'd' }
const DOC_THREAD: SessionKindRow = { channelType: 'doc_thread', visibility: 'workspace', channelId: 't' }
const OFFICE: SessionKindRow = { channelType: 'office_thread', visibility: 'workspace', channelId: 'o' }
const FEED_THREAD: SessionKindRow = { channelType: 'feed_thread', visibility: 'workspace', channelId: 'f' }
const INBOX: SessionKindRow = { channelType: 'notification', visibility: 'owner', channelId: 'notifications' }
const TELEGRAM_DM: SessionKindRow = { channelType: 'telegram', visibility: 'owner', channelId: '1' }
const WORKFLOW: SessionKindRow = { channelType: 'workflow', channelId: 'run' }
const PROGRAMMATIC: SessionKindRow = { channelType: 'programmatic', channelId: 'k' }
const A2A: SessionKindRow = { channelType: 'assistant-call', channelId: 'a' }
const CRON: SessionKindRow = { channelType: 'cron', channelId: 'j' }

describe('[COMP:api/session-policy] sessionPolicy drift ledger', () => {
  it('L1 tool interactivity: comes from the principal, so a human in an anchored thread is attended', () => {
    for (const channelType of ['doc_thread', 'office_thread', 'feed_thread', 'notification', 'web']) {
      expect(isAttendedTurn({ attended: true, channelType } as never)).toBe(true)
    }
    expect('interactivity' in policyFor(DOC_THREAD)).toBe(false)
  })

  it('L2 interactive sets: one answer per principal, whatever the transport', () => {
    for (const channelType of ['feishu', 'msteams', 'wechat', 'imessage']) {
      expect(isAttendedTurn({ attended: true, channelType } as never)).toBe(true)
      expect(isAttendedTurn({ attended: false, channelType } as never)).toBe(false)
    }
  })

  it('L3 read: one rule (membership + anchor gate) for the gate and the Live roster', () => {
    expect(policyFor(FEED_THREAD).read).toEqual({ rule: 'workspace', anchorGate: 'feed_collaboration' })
    expect(policyFor(DRAFT).read).toEqual({ rule: 'workspace', anchorGate: 'feed_draft_audience' })
    expect(policyFor(OFFICE).read).toEqual({ rule: 'workspace', anchorGate: 'office_file' })
    expect(policyFor(PERSONAL).read).toEqual({ rule: 'owner' })
  })

  it('L4 listing: the workspace list applies the same read rule as the gate', () => {
    expect(policyFor(ROOM).read).toEqual({ rule: 'workspace', anchorGate: 'none' })
    expect(Object.keys(policyFor(ROOM).read).sort()).toEqual(['anchorGate', 'rule'])
  })

  it('L5 confirmations: the addresser or an admin resolves in every workspace session', () => {
    for (const row of [ROOM, DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).confirmations).toBe('addresser_or_admin')
    }
    expect(policyFor(PERSONAL).confirmations).toBe('owner')
  })

  it('L6 live follow: one answer for every publisher, the sweeper and the stream', () => {
    for (const row of [ROOM, DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).liveFollow).toBe(true)
    }
    expect(policyFor(PERSONAL).liveFollow).toBe(false)
    // Whole-life follow is the presence surfaces only (rooms, the Office rail).
    expect(policyFor(ROOM).presence).toBe(true)
    expect(policyFor(OFFICE).presence).toBe(true)
    expect(policyFor(DOC_THREAD).presence).toBe(false)
    // The feed stream guard is the feed anchor's read gate, not a third list.
    expect(feedAnchoredRead(policyFor(DRAFT))).toBe(true)
    expect(feedAnchoredRead(policyFor(FEED_THREAD))).toBe(true)
    expect(feedAnchoredRead(policyFor(ROOM))).toBe(false)
  })

  it('L7 admission: every workspace session takes room admission; personal sessions the lease', () => {
    for (const row of [ROOM, DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).admission).toBe('room')
    }
    expect(policyFor(PERSONAL).admission).toBe('personal')
    // D12: rooms are mention-gated; anchored threads hear every message.
    expect(policyFor(ROOM).addressing).toBe('mention')
    for (const row of [DRAFT, DOC_THREAD, OFFICE, FEED_THREAD, PERSONAL]) {
      expect(policyFor(row).addressing).toBe('every_message')
    }
  })

  it('L8 attribution: every workspace session stamps senders and shows names to the model', () => {
    for (const row of [ROOM, DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).attribution).toBe(true)
      expect(policyFor(row).multiVoice).toBe(true)
    }
    expect(policyFor(PERSONAL).attribution).toBe(false)
    expect(policyFor({ ...PERSONAL, appOrigin: 'doc' }).multiVoice).toBe(true)
  })

  it('L9 delivery: ceiling and recipient type both follow the audience', () => {
    for (const row of [ROOM, DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).deliveryCeiling).toEqual({ ceiling: 'audience', recipientType: 'group' })
    }
    expect(policyFor(PERSONAL).deliveryCeiling).toEqual({ ceiling: 'owner', recipientType: 'individual' })
  })

  it('L10 clearance: an assistant recompute never overwrites an anchor-sourced clearance', () => {
    const office = policyFor(OFFICE)
    expect(office.clearanceSource).toBe('anchor')
    expect(office.clearanceRecompute).toBe(false)
    expect(policyFor(ROOM).clearanceRecompute).toBe(true)
    const sql = sessionKindSql.assistantClearanceSourced('s')
    expect(sql).toContain("s.channel_type <> 'office_thread'")
    expect(sql).toContain('s.guest_session_token IS NULL')
  })

  it('L11 lifecycle: participants rename and admins delete every workspace session', () => {
    for (const row of [ROOM, DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).lifecycle).toEqual({ rename: 'participants', delete: 'admin' })
    }
    expect(policyFor(PERSONAL).lifecycle).toEqual({ rename: 'owner', delete: 'owner' })
  })

  it('L12 create admission: only web chat rooms are admitted', () => {
    expect(policyFor(ROOM).createAdmission).toBe(true)
    for (const row of [DRAFT, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).createAdmission).toBe(false)
    }
  })

  it('L13 human activity: four consumers, four exclusion lists', () => {
    expect(policyFor(WORKFLOW).humanActivity).toEqual({ memory: true, playbook: true, live: false, search: false })
    expect(policyFor(A2A).humanActivity).toEqual({ memory: false, playbook: true, live: false, search: false })
    expect(policyFor(CRON).humanActivity).toEqual({ memory: false, playbook: false, live: true, search: false })
    expect(policyFor(OFFICE).humanActivity).toEqual({ memory: true, playbook: false, live: false, search: false })
  })

  it('L14 persisted row: tasks and CRM disagree on workflow runs', () => {
    expect(policyFor(WORKFLOW).persistedRow).toEqual({ tasks: false, crm: true })
    expect(policyFor(PROGRAMMATIC).persistedRow).toEqual({ tasks: false, crm: false })
  })

  it('L15 external channel sets: msteams and custom fall out of different lists', () => {
    expect(transportPolicy('msteams').delivery).toEqual({ preferredChannel: false, approvalNotify: true })
    expect(transportPolicy('custom').delivery).toEqual({ preferredChannel: true, approvalNotify: false })
  })

  it('L16 shared audience: personal memory loads in every personal-audience row, groups included', () => {
    expect(policyFor(TELEGRAM_DM).context.personalMemory).toBe(true)
    expect(policyFor(ROOM).context.personalMemory).toBe(false)
  })

  it('L18 billing: shared rooms bill the turn user', () => {
    expect(policyFor(ROOM).billing).toBe('user')
  })
})
