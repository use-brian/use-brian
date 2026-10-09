import { describe, expect, it } from 'vitest'
import { isAttendedTurn } from '@use-brian/core'
import { policyFor, transportPolicy, type SessionKindRow } from '../session-kind.js'

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

  it('L3 read: the Live roster skips the anchor gate the read gate applies', () => {
    const p = policyFor(FEED_THREAD)
    expect(p.read).toMatchObject({ rule: 'workspace', anchorGate: 'feed_collaboration' })
    expect(p.read.rosterAppliesAnchorGate).toBe(false)
  })

  it('L4 listing: the workspace list filters on clearance only, not the read gate', () => {
    expect(policyFor(ROOM).read.workspaceListAppliesReadGate).toBe(false)
  })

  it('L5 confirmations: addresser-or-admin applies to web rooms only', () => {
    expect(policyFor(ROOM).confirmations).toBe('addresser_or_admin')
    for (const row of [DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).confirmations).toBe('owner')
    }
  })

  it('L6 live follow: five consumers give five answers', () => {
    expect(policyFor(DRAFT).liveFollow).toEqual({ publish: true, toolInput: true, sweeperPublish: true, followStream: false, feedGuard: true })
    expect(policyFor(ROOM).liveFollow).toEqual({ publish: true, toolInput: false, sweeperPublish: true, followStream: true, feedGuard: false })
    expect(policyFor(FEED_THREAD).liveFollow).toEqual({ publish: false, toolInput: false, sweeperPublish: true, followStream: false, feedGuard: true })
    expect(policyFor(DOC_THREAD).liveFollow).toEqual({ publish: false, toolInput: false, sweeperPublish: true, followStream: false, feedGuard: false })
  })

  it('L7 admission: multi-human threads are serialized like personal sessions', () => {
    expect(policyFor(ROOM).admission).toBe('room')
    expect(policyFor(DRAFT).admission).toBe('draft_busy')
    for (const row of [DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).admission).toBe('personal')
    }
  })

  it('L8 attribution: threads stamp senders but names reach the model only in rooms', () => {
    expect(policyFor(ROOM).attribution).toEqual({ stamp: true, namesReachModel: true })
    for (const row of [DRAFT, DOC_THREAD, OFFICE, FEED_THREAD]) {
      expect(policyFor(row).attribution).toEqual({ stamp: true, namesReachModel: false })
    }
    expect(policyFor(PERSONAL).attribution).toEqual({ stamp: false, namesReachModel: false })
  })

  it('L9 delivery: the ceiling keys on audience but recipientType keys on room', () => {
    expect(policyFor(DOC_THREAD).deliveryCeiling).toEqual({ ceiling: 'audience', recipientType: 'individual' })
    expect(policyFor(ROOM).deliveryCeiling).toEqual({ ceiling: 'audience', recipientType: 'group' })
  })

  it('L10 clearance: a recompute overwrites anchor-sourced clearances', () => {
    const office = policyFor(OFFICE)
    expect(office.clearanceSource).toBe('anchor')
    expect(office.clearanceRecompute).toBe(true)
  })

  it('L11 lifecycle: admins may rename drafts and rooms but delete only rooms', () => {
    expect(policyFor(DRAFT).lifecycle).toEqual({ adminRename: true, adminDelete: false })
    expect(policyFor(ROOM).lifecycle).toEqual({ adminRename: true, adminDelete: true })
    expect(policyFor(DOC_THREAD).lifecycle).toEqual({ adminRename: false, adminDelete: false })
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
