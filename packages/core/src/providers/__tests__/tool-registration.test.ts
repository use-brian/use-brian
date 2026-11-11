import { describe, expect, it } from 'vitest'
import { registeredToolDefinitions } from '../tool-registration.js'
import { captureInputAdmissionProvider } from '../input-authority.js'
import { bindExactModelProvider, createRoutingProvider } from '../routing.js'
import { wrapProvider } from '../wrappers.js'
import { wrapEndpointFallback } from '../wrap-endpoint-fallback.js'
import type { LLMProvider, ToolDefinition } from '../types.js'

const definition = (name: string): ToolDefinition => ({ name, description: name, parameters: { type: 'object', properties: {} } })
describe('provider-neutral tool registration', () => {
  it('selects only the opted-in presentation, retaining array identity and fresh loads', () => {
    const tools = [definition('eager')], catalog = [...tools, definition('optional')], active = [definition('discoverTools')]
    const options = { tools, toolRegistration: { mode: 'deferred' as const, catalog, active } }
    expect(registeredToolDefinitions(options, 'eager')).toBe(tools)
    expect(registeredToolDefinitions(options, 'native-deferred')).toBe(catalog)
    expect(registeredToolDefinitions(options, 'dynamic')).toBe(active)
    active.push(catalog[0])
    expect(registeredToolDefinitions(options, 'dynamic')).toHaveLength(2)
    for (const mode of ['eager', 'dynamic', 'native-deferred'] as const) {
      expect(registeredToolDefinitions({ tools }, mode)).toBe(tools)
      expect(registeredToolDefinitions({}, mode)).toEqual([])
    }
  })

  it('forwards mode through captured, exact-model, routing, and endpoint wrappers', () => {
    const seen: string[] = []
    const child: LLMProvider = { name: 'fixture', models: [],
      toolSchemaMode(model) { expect(this.name).toBe('fixture'); seen.push(model); return 'native-deferred' },
      async *stream() {}, createSession: () => ({ async *send() {} }),
    }
    const wrapped = wrapProvider(wrapEndpointFallback(child, child))
    expect(captureInputAdmissionProvider(wrapped).toolSchemaMode?.('test')).toBe('native-deferred')
    expect(bindExactModelProvider(child, 'bound').toolSchemaMode?.('ignored')).toBe('native-deferred')
    expect(seen).toEqual(['test', 'bound'])
    const routing = createRoutingProvider({ gemini: child }, { resolveModel: () => 'gemini-3.8-flash' })
    expect(routing.toolSchemaMode?.('requested')).toBe('native-deferred')
    expect(seen.at(-1)).toBe('gemini-3.8-flash')
    const legacy = { ...child, toolSchemaMode: undefined }
    expect(wrapProvider(legacy).toolSchemaMode?.('test')).toBe('eager')
  })
})
