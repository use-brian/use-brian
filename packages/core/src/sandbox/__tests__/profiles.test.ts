/**
 * The profile gate + call-time choice (R2-4/R2-6/R2-10): an assistant browses
 * as a profile only when explicitly ENABLED for it and its CLEARANCE covers
 * the profile's rung, with the top rung (`confidential`) owner-only; the
 * profile is chosen at call time — one match auto-selects, several force the
 * model to name one.
 */
import { describe, it, expect } from 'vitest'
import {
  blockedProfilesFor,
  canUseProfile,
  profileIsNameableTo,
  describeProfileDenial,
  describeProfileDenials,
  createInMemoryBrowserProfileStore,
  createInMemorySessionVault,
  describeProfileResolution,
  resolveProfileForCall,
  routingNoteFor,
  type ProfileActor,
} from '../profiles.js'

const OWNER: ProfileActor = {
  userId: 'owner-1',
  workspaceId: 'ws-1',
  assistantId: 'asst-1',
  assistantClearance: 'confidential',
}

function store() {
  return createInMemoryBrowserProfileStore()
}

describe('[COMP:sandbox/profiles] Profile clearance + enablement gate (R2-4)', () => {
  it('refuses an assistant that is not explicitly enabled, whatever its clearance', async () => {
    const s = store()
    const p = await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'Personal',
      enabledAssistantIds: ['someone-else'],
    })
    expect(canUseProfile(p, OWNER)).toEqual({ ok: false, reason: 'not_enabled' })
  })

  it('refuses an assistant whose clearance does not cover the profile rung', async () => {
    const s = store()
    const p = await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'Team CRM',
      scope: 'workspace',
      clearance: 'internal',
      enabledAssistantIds: ['asst-1'],
    })
    expect(canUseProfile(p, { ...OWNER, assistantClearance: 'public' })).toEqual({
      ok: false,
      reason: 'clearance',
    })
    expect(canUseProfile(p, { ...OWNER, assistantClearance: 'internal' })).toEqual({ ok: true })
  })

  it('owner SCOPE is owner-only: a fully-cleared teammate’s assistant is still refused', async () => {
    const s = store()
    const p = await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'Personal',
      scope: 'owner',
      enabledAssistantIds: ['asst-1'],
    })
    // Same assistant, acting for a DIFFERENT user: denied despite clearance.
    // Pre-451 this guarantee rode on the `confidential` rung; it now says what
    // it means, so it holds whatever the rung happens to be.
    expect(canUseProfile(p, { ...OWNER, userId: 'teammate-2' })).toEqual({
      ok: false,
      reason: 'not_owner',
    })
    // The owner themself passes.
    expect(canUseProfile(p, OWNER)).toEqual({ ok: true })
  })

  it('new profiles default to the top rung — sharing is an explicit downgrade', async () => {
    const s = store()
    const p = await s.create({ workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Default' })
    expect(p.clearance).toBe('confidential')
    const downgraded = await s.update(p.id, { clearance: 'internal' })
    expect(downgraded?.clearance).toBe('internal')
  })
})

describe('[COMP:sandbox/profiles] Profile at call time (R2-10)', () => {
  it('exactly one enabled+cleared profile → auto-selected', async () => {
    const s = store()
    await s.create({ workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Other', enabledAssistantIds: [] })
    const usable = await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'Personal',
      enabledAssistantIds: ['asst-1'],
    })
    const res = await resolveProfileForCall({ store: s, actor: OWNER, site: 'instagram.com' })
    expect(res).toEqual({ kind: 'ok', profile: usable })
  })

  it('several matches → the assistant MUST name one (personal IG + company IG)', async () => {
    const s = store()
    await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Personal IG',
      clearance: 'internal', enabledAssistantIds: ['asst-1'],
    })
    await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Company IG',
      clearance: 'internal', enabledAssistantIds: ['asst-1'],
      assistantRoutingNotes: { 'asst-1': 'Use for the company brand account.' },
    })
    const res = await resolveProfileForCall({ store: s, actor: OWNER, site: 'instagram.com' })
    expect(res.kind).toBe('must_name')
    if (res.kind === 'must_name') {
      expect(res.candidates.sort()).toEqual(['Company IG', 'Personal IG'])
      expect(describeProfileResolution(res)).toMatch(/name one/i)
      expect(res.guidance).toEqual({ 'Company IG': 'Use for the company brand account.' })
      expect(describeProfileResolution(res)).toContain('company brand account')
    }
  })

  it('projects only the acting assistant note and normalizes whitespace', async () => {
    const s = store()
    const profile = await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'Company',
      enabledAssistantIds: ['asst-1'],
      assistantRoutingNotes: {
        'asst-1': '  Use for\ncompany accounts.  ',
        'asst-2': 'Private note for another assistant',
      },
    })
    expect(routingNoteFor(profile, 'asst-1')).toBe('Use for company accounts.')
    expect(routingNoteFor(profile, 'asst-3')).toBeNull()
  })

  it('prefers the profile already logged into the site (vault-informed narrowing)', async () => {
    const s = store()
    const vault = createInMemorySessionVault()
    const loggedIn = await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Personal IG',
      clearance: 'internal', enabledAssistantIds: ['asst-1'],
    })
    await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Company IG',
      clearance: 'internal', enabledAssistantIds: ['asst-1'],
    })
    await vault.put({
      profileId: loggedIn.id,
      site: 'instagram.com',
      bundle: { site: 'instagram.com', cookies: [], capturedAt: new Date().toISOString() },
    })
    const res = await resolveProfileForCall({ store: s, vault, actor: OWNER, site: 'instagram.com' })
    expect(res).toEqual({ kind: 'ok', profile: loggedIn })
  })

  it('a named profile resolves exactly; a named miss and a gate denial are honest errors', async () => {
    const s = store()
    const p = await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'Personal',
      enabledAssistantIds: ['asst-1'],
    })
    expect(
      await resolveProfileForCall({ store: s, actor: OWNER, profileName: 'Personal' }),
    ).toEqual({ kind: 'ok', profile: p })
    expect(
      await resolveProfileForCall({ store: s, actor: OWNER, profileName: 'Nope' }),
    ).toEqual({ kind: 'not_found', name: 'Nope' })
    const denied = await resolveProfileForCall({
      store: s,
      actor: { ...OWNER, userId: 'teammate-2' },
      profileName: 'Personal',
    })
    expect(denied.kind).toBe('denied')
    if (denied.kind === 'denied') expect(denied.reason).toBe('not_owner')
  })

  it('no enabled profile at all → none (identity-less browse is the caller’s decision)', async () => {
    const s = store()
    const res = await resolveProfileForCall({ store: s, actor: OWNER })
    expect(res).toEqual({ kind: 'none' })
  })

  /**
   * 2026-08-19: an `internal` assistant was ENABLED for a `confidential`
   * profile. `canUseProfile` refused on clearance, but every surface filtered
   * on `.ok` and dropped the reason, so the only remedy on offer was the
   * enablement the user had already done. They did it four more times.
   */
  it('a denial is not an absence: an enabled-but-under-clearance SHARED profile is reported with its reason', async () => {
    const s = store()
    await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'hinson-work',
      scope: 'workspace',
      clearance: 'confidential',
      enabledAssistantIds: ['asst-1'],
    })
    const actor: ProfileActor = { ...OWNER, assistantClearance: 'internal' }
    const res = await resolveProfileForCall({ store: s, actor })
    expect(res.kind).toBe('none')
    if (res.kind !== 'none') return
    expect(res.blocked).toEqual([
      { name: 'hinson-work', reason: 'clearance', clearance: 'confidential', nameable: false },
    ])

    const text = describeProfileResolution(res, actor.assistantClearance)
    // The obstacle is named; the PROFILE is not. An assistant's clearance
    // exists so it sees less than its user, so a rung it cannot cover is a
    // rung whose profile names it must not learn.
    expect(text).not.toContain('hinson-work')
    expect(text).toMatch(/internal/)
    expect(text).toMatch(/raise this assistant's clearance/i)
    expect(text).toMatch(/required clearance/i)
    // And never the remedy that cannot work.
    expect(text).toMatch(/will NOT help/i)
    expect(text).not.toMatch(/create one in Browsers/i)
  })

  /**
   * D1 (plan §1): the incident state itself. An `internal` assistant, enabled
   * for its OWNER's private profile, may use it - clearance does not gate an
   * owner-scoped profile, because enablement is already the owner's grant.
   * Before migration 451 this exact configuration was unrepresentable: asking
   * for "only me" forced the `confidential` rung and refused the assistant.
   */
  it('an owner-scoped profile is usable by the owner’s enabled assistant at ANY clearance', async () => {
    const s = store()
    const p = await s.create({
      workspaceId: 'ws-1',
      ownerUserId: 'owner-1',
      name: 'hinson-work',
      scope: 'owner',
      clearance: 'confidential',
      enabledAssistantIds: ['asst-1'],
    })
    for (const assistantClearance of ['public', 'internal', 'confidential'] as const) {
      expect(canUseProfile(p, { ...OWNER, assistantClearance })).toEqual({ ok: true })
    }
    // ...but only for its owner's turns.
    expect(canUseProfile(p, { ...OWNER, userId: 'teammate-2' })).toEqual({
      ok: false,
      reason: 'not_owner',
    })
  })

  it('a workspace-scoped profile still gates on clearance, and enablement is still first', async () => {
    const s = store()
    const shared = await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'shared',
      scope: 'workspace', clearance: 'confidential', enabledAssistantIds: ['asst-1'],
    })
    expect(canUseProfile(shared, { ...OWNER, assistantClearance: 'internal' })).toEqual({
      ok: false,
      reason: 'clearance',
    })
    // Enablement short-circuits before scope or clearance are consulted, which
    // is precisely why nameability may never be derived from the reason.
    const unToggled = await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'un-toggled',
      scope: 'workspace', clearance: 'confidential', enabledAssistantIds: [],
    })
    expect(canUseProfile(unToggled, { ...OWNER, assistantClearance: 'internal' })).toEqual({
      ok: false,
      reason: 'not_enabled',
    })
    expect(profileIsNameableTo(unToggled, { ...OWNER, assistantClearance: 'internal' })).toBe(false)
  })

  /**
   * The disclosure test is reachability, never the denial reason.
   * `canUseProfile` returns `not_enabled` BEFORE it evaluates clearance, so a
   * `confidential` profile that is merely un-toggled reports `not_enabled` -
   * naming it on that basis would leak exactly what the rung withholds.
   */
  it('withholds the name of an un-toggled profile that is ALSO above clearance', () => {
    const text = describeProfileDenial(
      { name: 'acme-diligence-login', reason: 'not_enabled', clearance: 'confidential', nameable: false },
      'internal',
    )
    expect(text).not.toContain('acme-diligence-login')
    expect(text).toMatch(/name is withheld/i)
  })

  it('names a profile the assistant IS cleared for, so the ordinary toggle case stays actionable', () => {
    const text = describeProfileDenial(
      { name: 'team-shared', reason: 'not_enabled', clearance: 'internal', nameable: true },
      'internal',
    )
    expect(text).toContain('team-shared')
    expect(text).toMatch(/Assistant > Tools > Browser identities/)
  })

  it('collapses several unnameable profiles into one obstacle, disclosing no count', () => {
    const text = describeProfileDenials(
      [
        { name: 'zenith-vault', reason: 'clearance', clearance: 'confidential', nameable: false },
        { name: 'quorum-books', reason: 'not_enabled', clearance: 'confidential', nameable: false },
        { name: 'lodestar-admin', reason: 'clearance', clearance: 'confidential', nameable: false },
      ],
      'internal',
    )
    for (const name of ['zenith-vault', 'quorum-books', 'lodestar-admin']) {
      expect(text).not.toContain(name)
    }
    // One sentence run, not three identical paragraphs that also count them.
    expect(text.match(/name is withheld/gi)).toHaveLength(1)
  })

  it('blockedProfilesFor reports every gated profile with the gate’s own reason', async () => {
    const s = store()
    await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'not-enabled',
      scope: 'workspace', clearance: 'public', enabledAssistantIds: [],
    })
    await s.create({
      workspaceId: 'ws-1', ownerUserId: 'owner-1', name: 'too-high',
      scope: 'workspace', clearance: 'confidential', enabledAssistantIds: ['asst-1'],
    })
    const actor: ProfileActor = { ...OWNER, assistantClearance: 'internal' }
    const all = await s.list({ workspaceId: 'ws-1' })
    expect(blockedProfilesFor(all, actor)).toEqual([
      { name: 'not-enabled', reason: 'not_enabled', clearance: 'public', nameable: true },
      { name: 'too-high', reason: 'clearance', clearance: 'confidential', nameable: false },
    ])
  })

  it('the clearance denial says enabling again will not help; the not-enabled one still points at the toggle', () => {
    const clearance = describeProfileDenial(
      { name: 'p', reason: 'clearance', clearance: 'confidential', nameable: false },
      'internal',
    )
    expect(clearance).toMatch(/will NOT help/i)
    expect(clearance).not.toContain('"p"')

    const notEnabled = describeProfileDenial(
      { name: 'p', reason: 'not_enabled', clearance: 'public', nameable: true },
      'internal',
    )
    expect(notEnabled).toContain('"p"')
    expect(notEnabled).toMatch(/Assistant > Tools > Browser identities/)
    expect(notEnabled).not.toMatch(/will NOT help/i)
  })

  it('a workspace with genuinely zero profiles still returns a bare none', async () => {
    const s = store()
    const res = await resolveProfileForCall({ store: s, actor: OWNER })
    expect(res).toEqual({ kind: 'none' })
    if (res.kind === 'ok') throw new Error('unreachable: an empty store cannot resolve')
    expect(describeProfileResolution(res, 'internal')).toMatch(/create one in Browsers/i)
  })
})
