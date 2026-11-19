import { describe, expect, it } from 'vitest'
import { HOME_APP_TOOL_CONFIG, HOME_APP_TOOL_CAPABILITIES, DEFAULT_HOME_APP_TOOL_CAPABILITIES, homeAppToolRequirements, homeAppToolSetCapability } from '../home-app-tool-config.js'

describe('[COMP:shared/home-app-tool-config] mini-app tool declarations', () => {
  it('declares native apps with unique app and set grants', () => {
    expect(HOME_APP_TOOL_CONFIG.map((app) => app.id)).toEqual(['page', 'office', 'browsers', 'tasks', 'crm', 'feed'])
    expect(new Set(HOME_APP_TOOL_CAPABILITIES).size).toBe(HOME_APP_TOOL_CAPABILITIES.length)
  })
  it('keeps retired Association unavailable and composes contact authority without granting configuration', () => {
    expect(DEFAULT_HOME_APP_TOOL_CAPABILITIES.some(cap => cap.includes('association'))).toBe(false)
    for (const isReadOnly of [true, false]) {
      const set = isReadOnly ? 'read' : 'write'
      expect(homeAppToolRequirements({ requiresCapability: 'crm', isReadOnly, homeAppToolSet: { app: 'page', set } }))
        .toEqual(['page', `home_app:page:${set}`, 'crm', `home_app:crm:${set}`])
    }
  })
  it.each(HOME_APP_TOOL_CONFIG)('requires the $id app AND its selected set', (app) => {
    expect(homeAppToolRequirements({ requiresCapability: app.capability, isReadOnly: true }))
      .toEqual([app.capability, homeAppToolSetCapability(app.id, 'read')])
    expect(homeAppToolRequirements({ requiresCapability: app.capability, isReadOnly: false }))
      .toEqual([app.capability, homeAppToolSetCapability(app.id, 'write')])
  })
  it('supports explicit app metadata on injected tools and refuses undeclared sets', () => {
    expect(homeAppToolRequirements({ isReadOnly: false, homeAppToolSet: { app: 'feed', set: 'write' } }))
      .toEqual(['feed', 'home_app:feed:write'])
    expect(homeAppToolRequirements({ isReadOnly: true, homeAppToolSet: { app: 'page', set: 'undeclared' } }))
      .toEqual(['home_app:unknown'])
    expect(homeAppToolRequirements({ isReadOnly: true })).toEqual([])
  })
})
