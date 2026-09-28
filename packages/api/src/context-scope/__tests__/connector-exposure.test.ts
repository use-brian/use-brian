import { describe, expect, it } from 'vitest'
import { runWithAgentAccess, runWithAgentClearance } from '../../db/agent-access-context.js'
import { connectorExposureAllowed } from '../connector-exposure.js'

describe('[COMP:api/connector-context] connectorExposureAllowed', () => {
  it('permits an unbounded exposure only for a universe turn', () => {
    expect(connectorExposureAllowed(
      { effectiveCompartments: null, effectiveProjectIds: null },
      { compartments: [], projectIds: [] },
    )).toBe(true)
    expect(connectorExposureAllowed(
      { effectiveCompartments: ['team:sales'], effectiveProjectIds: null },
      { compartments: [], projectIds: [] },
    )).toBe(false)
  })

  it('withholds generic provider catalogs from finite turns even when bindings fit', () => {
    const turn = {
      effectiveCompartments: ['team:sales', 'team:strategy'],
      effectiveProjectIds: ['11111111-1111-4111-8111-111111111111'],
    }
    const binding = {
      compartments: ['team:sales'],
      projectIds: ['11111111-1111-4111-8111-111111111111'],
    }
    expect(connectorExposureAllowed(turn, binding)).toBe(false)
    expect(connectorExposureAllowed(turn, binding, 'fixed-operation')).toBe(true)
    expect(connectorExposureAllowed(turn, {
      compartments: ['team:accounting'],
      projectIds: ['11111111-1111-4111-8111-111111111111'],
    })).toBe(false)
    expect(connectorExposureAllowed(turn, {
      compartments: ['team:sales'],
      projectIds: [],
    })).toBe(false)
  })

  it('keeps undefined scope compatible for non-execution/admin callers', () => {
    expect(connectorExposureAllowed(undefined, { compartments: [], projectIds: [] })).toBe(true)
  })
})

describe('[COMP:api/connector-context] independent connector mutation authority', () => {
  const binding = { compartments: ['team:product'], projectIds: ['project'] }
  const readGrant = { effectiveCompartments: ['team:product', 'team:marketing'],
    effectiveProjectIds: ['project'], access: { mutationCompartments: ['team:marketing'] } }

  it('withholds an entire connector accessible only by a read grant', () => {
    expect(connectorExposureAllowed(readGrant, binding)).toBe(false)
    expect(connectorExposureAllowed({ ...readGrant,
      access: { mutationCompartments: ['team:product'] } }, binding)).toBe(false)
    expect(connectorExposureAllowed({ ...readGrant,
      access: { mutationCompartments: ['team:product'] } }, binding, 'fixed-operation')).toBe(true)
    expect(connectorExposureAllowed({ ...readGrant,
      effectiveCompartments: [], access: { mutationCompartments: null } }, binding)).toBe(false)
    expect(connectorExposureAllowed({ effectiveCompartments: null, effectiveProjectIds: null,
      access: { mutationCompartments: [] } }, { compartments: [], projectIds: [] })).toBe(false)
  })

  it('retains the narrower active mutation grant even with a broader or omitted turn', async () => {
    await runWithAgentAccess({ clearance: 'internal', compartments: readGrant.effectiveCompartments,
      mutationCompartments: ['team:marketing'], projectIds: ['project'] }, async () => {
      await Promise.resolve()
      expect(connectorExposureAllowed(undefined, binding)).toBe(false)
      expect(connectorExposureAllowed({ effectiveCompartments: null, effectiveProjectIds: null,
        access: { mutationCompartments: null } }, binding)).toBe(false)
      expect(connectorExposureAllowed(undefined,
        { compartments: ['team:marketing'], projectIds: ['project'] })).toBe(false)
      expect(connectorExposureAllowed(undefined,
        { compartments: ['team:marketing'], projectIds: ['project'] }, 'fixed-operation')).toBe(true)
      await runWithAgentAccess({ clearance: 'confidential', compartments: null,
        mutationCompartments: null, projectIds: null }, async () => {
        expect(connectorExposureAllowed(undefined, binding)).toBe(false)
      })
    })
  })

  it('does not interpret clearance-only execution as connector authority', () => {
    runWithAgentClearance('internal', () => {
      expect(connectorExposureAllowed(undefined, binding)).toBe(false)
      expect(connectorExposureAllowed({ effectiveCompartments: null,
        effectiveProjectIds: null }, { compartments: [], projectIds: [] })).toBe(false)
    })
  })

  it('retains project restrictions and legacy explicit universe authority', () => {
    runWithAgentAccess({ clearance: 'internal', compartments: null, projectIds: ['other'] }, () => {
      expect(connectorExposureAllowed(undefined, binding)).toBe(false)
    })
    runWithAgentAccess({ clearance: 'internal', compartments: null, projectIds: null }, () => {
      expect(connectorExposureAllowed(undefined, { compartments: [], projectIds: [] })).toBe(true)
    })
  })
})
