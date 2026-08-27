import { describe, expect, it } from 'vitest'
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

  it('requires every finite exposure requirement to fit both turn axes', () => {
    const turn = {
      effectiveCompartments: ['team:sales', 'team:strategy'],
      effectiveProjectIds: ['11111111-1111-4111-8111-111111111111'],
    }
    expect(connectorExposureAllowed(turn, {
      compartments: ['team:sales'],
      projectIds: ['11111111-1111-4111-8111-111111111111'],
    })).toBe(true)
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
