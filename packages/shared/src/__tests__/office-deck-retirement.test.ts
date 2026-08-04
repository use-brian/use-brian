import { describe, expect, it } from 'vitest'
import { BOOT_INJECTED_BUILTIN_TOOLS, OFFICIAL_CONNECTOR_TOOLS } from '../builtin-connectors.js'
import { TOOL_DISPLAY_NAMES } from '../tool-display-names.js'

const retiredTools = ['generatePowerpoint', 'updatePowerpoint', 'getPowerpoint']

describe('[COMP:office/deck-retirement] Legacy Deck retirement', () => {
  it('keeps retired Deck tools out of every active built-in registry', () => {
    const advertised = Object.values(OFFICIAL_CONNECTOR_TOOLS).flat().map((tool) => tool.name)
    const bootInjected = Object.values(BOOT_INJECTED_BUILTIN_TOOLS).flat()
    for (const tool of retiredTools) {
      expect(advertised).not.toContain(tool)
      expect(bootInjected).not.toContain(tool)
      expect(TOOL_DISPLAY_NAMES).not.toHaveProperty(tool)
    }
  })

  it('advertises only the canonical Office replacement tools', () => {
    expect(OFFICIAL_CONNECTOR_TOOLS.office.map((tool) => tool.name)).toEqual([
      'createOfficeArtifact',
      'getOfficeArtifact',
      'reviseOfficeArtifact',
    ])
    expect(BOOT_INJECTED_BUILTIN_TOOLS.office).toEqual([
      'createOfficeArtifact',
      'getOfficeArtifact',
      'reviseOfficeArtifact',
    ])
  })
})
