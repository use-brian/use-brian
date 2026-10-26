import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ResolvedTurnScope } from '../../context-scope/resolve-turn-scope.js'
import { createConnectorRuntimeAuthority } from '../connector-runtime-authority.js'

describe('[COMP:api/connector-context] common native runtime admission', () => {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), department = randomUUID()
  const facts = { workspaceId, assistantId, initiatingUserId: userId, identityUserId: userId }
  const binding = { compartments: [`team:${department}`], projectIds: [] }, general = { compartments: [], projectIds: [] }
  function scope(departments: Record<string, 'public' | 'internal' | 'confidential'> = { [department]: 'internal' }): ResolvedTurnScope {
    return { access: { workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'internal', compartments: null,
      mutationCompartments: null, projectIds: null, visibilityAssistantIds: [assistantId],
      departmentRead: { workspaceId, userId, assistantId, base: 'internal', departments, contextDepartment: null, binding: null, cap: null } },
    activeGroupId: null, activeProjectId: null, activeTeam: null, activeProject: null, effectiveCompartments: null,
    effectiveProjectIds: null, writeCompartments: [], writeProjectIds: [] }
  }
  it('never substitutes credential ownership for missing actual actor facts', async () => {
    const authority = await createConnectorRuntimeAuthority({ workspaceId, assistantId }, async () => { throw new Error('must not resolve an owner') })
    expect(authority.allows(binding)).toBe(false); expect(authority.allows(general)).toBe(true)
    const conflict = await createConnectorRuntimeAuthority({ ...facts, identityUserId: randomUUID() })
    expect(conflict.allows(binding)).toBe(false); expect(conflict.allows(general)).toBe(false)
    await expect(conflict.execute(async () => 'never')).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('denies labelled connectors to a verified non-member while retaining explicit General classification', async () => {
    let calls = 0
    const authority = await createConnectorRuntimeAuthority(facts, async () => { calls++; return { scope: null } })
    expect(authority.allows(binding)).toBe(false); expect(authority.allows(general)).toBe(true)
    expect(await authority.execute(async () => 'General')).toBe('General'); expect(calls).toBe(3)
  })
  it('does not revive a revoked native floor after restoration and prevents further effects', async () => {
    let current = scope(), effects = 0
    const authority = await createConnectorRuntimeAuthority(facts, async () => ({ scope: current }))
    expect(authority.allows(binding)).toBe(true)
    expect(await authority.execute(async () => ++effects)).toBe(1)
    current = scope({})
    await expect(authority.execute(async () => ++effects)).rejects.toMatchObject({ reason: 'authority_changed' })
    current = scope()
    await expect(authority.execute(async () => ++effects)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(effects).toBe(1)
  })
  it('withholds a result after an interleaved floor contraction and marks a potentially completed effect uncertain', async () => {
    let current = scope(), effects = 0
    const authority = await createConnectorRuntimeAuthority(facts, async () => ({ scope: current }))
    await expect(authority.execute(async () => { effects++; current = scope({}); return 'protected bytes' }))
      .rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true, retrySafe: false })
    expect(effects).toBe(1)
  })
  it('fails closed on metadata outage, missing assistant or substituted principal', async () => {
    await expect(createConnectorRuntimeAuthority(facts, async () => null)).rejects.toMatchObject({ reason: 'authority_changed' })
    const wrong = scope(); wrong.access.userId = randomUUID()
    await expect(createConnectorRuntimeAuthority(facts, async () => ({ scope: wrong }))).rejects.toMatchObject({ reason: 'authority_changed' })
    let unavailable = false
    const authority = await createConnectorRuntimeAuthority(facts, async () => { if (unavailable) throw new Error('metadata unavailable'); return { scope: scope() } })
    unavailable = true
    await expect(authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })
  it('keys cached metadata by actual actor, executing assistant, workspace and native floor', async () => {
    const first = await createConnectorRuntimeAuthority(facts, async () => ({ scope: scope() }))
    const same = await createConnectorRuntimeAuthority(facts, async () => ({ scope: scope() }))
    const narrowed = await createConnectorRuntimeAuthority(facts, async () => ({ scope: scope({}) }))
    expect(first.cacheKey).toBe(same.cacheKey); expect(first.cacheKey).not.toBe(narrowed.cacheKey)
    for (const changed of [{ ...facts, initiatingUserId: randomUUID(), identityUserId: undefined },
      { ...facts, assistantId: randomUUID() }, { ...facts, workspaceId: randomUUID() }]) {
      const anonymous = await createConnectorRuntimeAuthority(changed, async () => ({ scope: null }))
      expect(first.cacheKey).not.toBe(anonymous.cacheKey)
    }
  })
})
