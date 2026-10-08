import { describe, expect, it } from 'vitest'
import { runWithAgentAccess, runWithAgentClearance } from '../../db/agent-access-context.js'
import { connectorExposureAllowed } from '../connector-exposure.js'

const P = '11111111-1111-4111-8111-111111111111'
const general = { compartments: [], projectIds: [] }

describe('[COMP:api/connector-context] connectorExposureAllowed (audience)', () => {
  it('lets every turn use a General connector', () => {
    expect(connectorExposureAllowed({ effectiveCompartments: null, effectiveProjectIds: null }, general)).toBe(true)
    expect(connectorExposureAllowed({ effectiveCompartments: ['team:sales'], effectiveProjectIds: null }, general)).toBe(true)
    expect(connectorExposureAllowed({ effectiveCompartments: [], effectiveProjectIds: [] }, general)).toBe(true)
  })

  it('lets a department connector reach only turns inside that department', () => {
    const turn = { effectiveCompartments: ['team:sales', 'team:strategy'], effectiveProjectIds: [P] }
    expect(connectorExposureAllowed(turn, { compartments: ['team:sales'], projectIds: [P] })).toBe(true)
    expect(connectorExposureAllowed(turn, { compartments: ['team:sales'], projectIds: [] })).toBe(true)
    expect(connectorExposureAllowed(turn, { compartments: ['team:accounting'], projectIds: [] })).toBe(false)
    expect(connectorExposureAllowed(turn, { compartments: [], projectIds: ['other'] })).toBe(false)
    expect(connectorExposureAllowed({ effectiveCompartments: null, effectiveProjectIds: null },
      { compartments: ['team:accounting'], projectIds: [] })).toBe(true)
  })

  it('keeps undefined scope compatible for non-execution/admin callers', () => {
    expect(connectorExposureAllowed(undefined, { compartments: ['team:x'], projectIds: [] })).toBe(true)
  })
})

describe('[COMP:api/connector-context] independent connector mutation authority', () => {
  const binding = { compartments: ['team:product'], projectIds: ['project'] }
  const readGrant = { effectiveCompartments: ['team:product', 'team:marketing'],
    effectiveProjectIds: ['project'], access: { mutationCompartments: ['team:marketing'] } }

  it('a temporary read grant is not membership in the connector audience', () => {
    expect(connectorExposureAllowed(readGrant, binding)).toBe(false)
    expect(connectorExposureAllowed({ ...readGrant,
      access: { mutationCompartments: ['team:product'] } }, binding)).toBe(true)
    expect(connectorExposureAllowed({ ...readGrant,
      effectiveCompartments: [], access: { mutationCompartments: null } }, binding)).toBe(false)
  })

  it('retains the narrower active mutation grant even with a broader or omitted turn', async () => {
    await runWithAgentAccess({ clearance: 'internal', compartments: readGrant.effectiveCompartments,
      mutationCompartments: ['team:marketing'], projectIds: ['project'] }, async () => {
      await Promise.resolve()
      expect(connectorExposureAllowed(undefined, binding)).toBe(false)
      expect(connectorExposureAllowed({ effectiveCompartments: null, effectiveProjectIds: null,
        access: { mutationCompartments: null } }, binding)).toBe(false)
      expect(connectorExposureAllowed(undefined,
        { compartments: ['team:marketing'], projectIds: ['project'] })).toBe(true)
      expect(connectorExposureAllowed(undefined, general)).toBe(true)
    })
  })

  it('does not interpret clearance-only execution as connector authority', () => {
    runWithAgentClearance('internal', () => {
      expect(connectorExposureAllowed(undefined, binding)).toBe(false)
      expect(connectorExposureAllowed({ effectiveCompartments: null,
        effectiveProjectIds: null }, general)).toBe(false)
    })
  })

  it('retains project restrictions and explicit universe authority', () => {
    runWithAgentAccess({ clearance: 'internal', compartments: null, projectIds: ['other'] }, () => {
      expect(connectorExposureAllowed(undefined, binding)).toBe(false)
    })
    runWithAgentAccess({ clearance: 'internal', compartments: null, projectIds: null }, () => {
      expect(connectorExposureAllowed(undefined, binding)).toBe(true)
    })
  })
})

describe('[COMP:api/connector-context] v2 department floor', () => {
  const grant = { workspaceId: 'workspace', userId: 'viewer', assistantId: 'assistant', base: 'internal' as const,
    departments: { sales: 'internal' as const }, contextDepartment: null, binding: null, cap: null }
  const turn = { effectiveCompartments: null, effectiveProjectIds: null, access: { mutationCompartments: null, departmentRead: grant } }
  const audience = { compartments: ['team:sales'], projectIds: [] }
  it('does not treat legacy universe reach as a department edge', () => {
    expect(connectorExposureAllowed(turn, audience)).toBe(true)
    expect(connectorExposureAllowed({ ...turn, access: { departmentRead: { ...grant, departments: {} } } }, audience)).toBe(false)
    expect(connectorExposureAllowed(turn, { compartments: ['team:sales','team:other'], projectIds: [] })).toBe(false)
  })
  it('honors active context and credential binding independently', () => {
    expect(connectorExposureAllowed({ ...turn, access: { departmentRead: { ...grant, contextDepartment: 'other' } } }, audience)).toBe(false)
    expect(connectorExposureAllowed({ ...turn, access: { departmentRead: { ...grant, binding: [] } } }, audience)).toBe(false)
    expect(connectorExposureAllowed(turn, general)).toBe(true)
  })
  it('retains the narrower ambient grant even with broad explicit scope', () => {
    runWithAgentAccess({ clearance: 'internal', compartments: null, departmentRead: { ...grant, departments: {} } }, () => {
      expect(connectorExposureAllowed(turn, audience)).toBe(false)
    })
  })
})
