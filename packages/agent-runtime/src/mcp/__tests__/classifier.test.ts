import { describe, it, expect } from 'vitest'
import { classifyTool, defaultPolicy } from '../classifier.js'

describe('[COMP:mcp/classifier] MCP tool classifier', () => {
  it('classifies read tools', () => {
    expect(classifyTool('getCalendarEvents')).toBe('read')
    expect(classifyTool('listDocuments')).toBe('read')
    expect(classifyTool('searchContacts')).toBe('read')
    expect(classifyTool('fetchWeather')).toBe('read')
  })

  it('classifies write tools', () => {
    expect(classifyTool('createEvent')).toBe('write')
    expect(classifyTool('sendMessage')).toBe('write')
    expect(classifyTool('updateDocument')).toBe('write')
  })

  it('classifies destructive tools', () => {
    expect(classifyTool('deleteEvent')).toBe('destructive')
    expect(classifyTool('removeContact')).toBe('destructive')
    expect(classifyTool('clearHistory')).toBe('destructive')
  })

  it('uses description when name is ambiguous', () => {
    expect(classifyTool('doThing', 'Retrieves data from the API')).toBe('read')
    expect(classifyTool('doThing', 'Creates a new record')).toBe('write')
    expect(classifyTool('doThing', 'Permanently deletes all data')).toBe('destructive')
  })

  it('defaults to unknown for unrecognizable tools', () => {
    expect(classifyTool('xyz')).toBe('unknown')
  })
})

describe('[COMP:mcp/classifier] defaultPolicy', () => {
  it('allows reads, asks for writes, blocks destructive', () => {
    expect(defaultPolicy('read')).toBe('allow')
    expect(defaultPolicy('write')).toBe('ask')
    expect(defaultPolicy('destructive')).toBe('block')
    expect(defaultPolicy('unknown')).toBe('ask')
  })
})
