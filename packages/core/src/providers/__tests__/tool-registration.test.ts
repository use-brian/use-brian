import { describe, expect, it } from 'vitest'
import { registeredToolDefinitions, toolDiscoveryInstructions } from '@use-brian/agent-runtime/providers/tool-registration.js'
import { captureInputAdmissionProvider } from '@use-brian/agent-runtime/providers/input-authority.js'
import { bindExactModelProvider, createRoutingProvider } from '@use-brian/agent-runtime/providers/routing.js'
import { wrapProvider } from '@use-brian/agent-runtime/providers/wrappers.js'
import { wrapFallback } from '@use-brian/agent-runtime/providers/wrap-fallback.js'
import { wrapEndpointFallback } from '@use-brian/agent-runtime/providers/wrap-endpoint-fallback.js'
import type { LLMProvider, ProviderRequest, ToolDefinition } from '@use-brian/agent-runtime/providers/types.js'
import { createLlmDecisionProvider } from '../../decisions/adapters/llm.js'
import { decisionRequest } from '../../decisions/__tests__/fixtures.js'

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

  it('scopes discovery to the actual driver and its final admitted schemas', () => {
    const catalog = ['saveMemory', 'readFile', 'mcp_search', 'mcp_call'].map(definition)
    const active = ['mcp_search', 'mcp_call', 'discoverTools'].map(definition)
    const options = { tools: catalog, toolRegistration: { mode: 'deferred' as const, catalog, active } }
    const native = toolDiscoveryInstructions(options, 'native-deferred')
    expect(native).toContain('native tool search')
    expect(native).not.toContain('`discoverTools`')
    expect(native).toContain('separate connected-service catalog, not all Brian tools')
    expect(native).toContain('does not rule out a Brian tool')
    expect(native).toContain('does not rule out a folded connector tool')
    const dynamic = toolDiscoveryInstructions(options, 'dynamic')
    expect(dynamic).toContain('`discoverTools`')
    expect(dynamic).not.toContain('native tool search')
    expect(dynamic).toContain('not execution permission')
    // An eager fallback must not inherit a helper or native search it lacks.
    expect(toolDiscoveryInstructions(options, 'eager')).toBe('')
    for (const mode of ['eager', 'dynamic', 'native-deferred'] as const) {
      expect(toolDiscoveryInstructions({ tools: catalog }, mode)).toBe('')
    }
    const restricted = { tools: [], toolRegistration: { mode: 'deferred' as const,
      catalog: [definition('readFile')], active: [definition('discoverTools')] } }
    expect(toolDiscoveryInstructions(restricted, 'native-deferred')).not.toContain('mcp_search')
    expect(toolDiscoveryInstructions(restricted, 'dynamic')).not.toContain('mcp_search')
    expect(toolDiscoveryInstructions({ toolRegistration: { ...restricted.toolRegistration, active: [] } }, 'dynamic')).toBe('')
    for (const mode of ['dynamic', 'native-deferred'] as const) {
      expect(toolDiscoveryInstructions({ toolRegistration: { mode: 'deferred', catalog, active: [...catalog, definition('discoverTools')] } }, mode)).toBe('')
    }
  })

  it('renders the unified catalog only when the engine has bound it', () => {
    const catalog = ['mcp_search', 'saveMemory'].map(definition)
    const options = { toolRegistration: { mode: 'deferred' as const, discoveryTool: 'mcp_search' as const,
      catalog, active: [catalog[0], definition('discoverTools')] } }
    for (const mode of ['dynamic', 'native-deferred'] as const) {
      const instructions = toolDiscoveryInstructions(options, mode)
      expect(instructions).toContain('final admitted Brian tool catalog together with indexed')
      expect(instructions).toContain('follow nextOffset until null')
      expect(instructions).not.toContain('separate connected-service catalog')
      if (mode === 'native-deferred') expect(instructions).toContain('native tool search for that exact name')
      else expect(instructions).toContain('Matching native schemas are loaded for the next call')
    }
    expect(toolDiscoveryInstructions(options, 'eager')).toBe('')
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


describe('descriptive thinking metadata', () => {
  it('matches exact decision dispatch instead of borrowing Auto effort from a different model', async () => {
    const calls: ProviderRequest[] = []
    const child: LLMProvider = { name: 'fixture', models: ['gpt-6-luna', 'gpt-6.1-terra'],
      supportedThinkingLevels: model => model === 'gpt-6-luna' ? ['low'] : ['high'],
      async *stream(request) {
        calls.push(request)
        yield { type: 'message_start', model: request.model }
        yield { type: 'text_delta', text: JSON.stringify({ answers: { intent: { value: 'ordinary', confidence: null } } }) }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      },
      createSession: () => ({ async *send() {} }),
    }
    const routing = createRoutingProvider({ 'openai-codex': child }, { resolveModel: () => 'gpt-6-luna' })
    const wrapped = captureInputAdmissionProvider(wrapProvider(routing))
    expect(wrapped.supportedThinkingLevels?.('gpt-6.1-terra')).toEqual(['low'])
    expect(wrapped.supportedThinkingLevels?.('gpt-6.1-terra', { allowProviderFallback: false })).toEqual(['high'])
    expect(bindExactModelProvider(wrapped, 'gpt-6.1-terra').supportedThinkingLevels?.('ignored')).toEqual(['high'])
    const request = decisionRequest()
    request.model = { catalogId: 'gpt-6.1-terra', wireId: 'gpt-6.1-terra' }
    await createLlmDecisionProvider({ provider: wrapped }).evaluate(request)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('gpt-6.1-terra')
    expect(calls[0]!.allowProviderFallback).toBe(false)
    expect(calls[0]!.thinkingLevel).toBeUndefined()
  })

  it('preserves an authority refusal even in a descriptive capability query', () => {
    const refusal = Object.assign(new Error('Synthetic authority refusal'), { reason: 'authority_changed' })
    const child: LLMProvider = { name: 'fixture', models: ['gpt-6-luna'],
      supportedThinkingLevels: () => { throw refusal },
      async *stream() {}, createSession: () => ({ async *send() {} }),
    }
    const routing = createRoutingProvider({ 'openai-codex': child })
    expect(() => routing.supportedThinkingLevels?.('gpt-6-luna', { allowProviderFallback: false })).toThrow(refusal)
  })

  it('binds captured methods, resolves actual models, and conservatively intersects fallbacks', () => {
    const seen: string[] = []
    const child: LLMProvider = { name: 'fixture', models: ['default-fallback'],
      supportedThinkingLevels(model) { expect(this).toBe(child); seen.push(model); return ['low', 'high'] },
      async *stream() {}, createSession: () => ({ async *send() {} }),
    }
    const captured = captureInputAdmissionProvider(child)
    child.supportedThinkingLevels = function () { expect(this).toBe(child); return ['high'] }
    expect(captured.supportedThinkingLevels?.('captured')).toEqual(['low', 'high'])
    expect(wrapProvider(child).supportedThinkingLevels?.('wrapped')).toEqual(['high'])
    expect(bindExactModelProvider(captured, 'bound').supportedThinkingLevels?.('ignored')).toEqual(['low', 'high'])
    const routing = createRoutingProvider({ gemini: captured }, { resolveModel: () => 'gemini-3.8-flash' })
    expect(routing.supportedThinkingLevels?.('requested')).toEqual(['low', 'high'])
    expect(seen).toEqual(['captured', 'bound', 'gemini-3.8-flash'])
    expect(createRoutingProvider({}).supportedThinkingLevels?.('unknown')).toEqual([])
    const legacy = { ...child, supportedThinkingLevels: undefined }
    expect(captureInputAdmissionProvider(legacy).supportedThinkingLevels?.('unknown')).toEqual([])
    expect(wrapFallback(captured, legacy).supportedThinkingLevels?.('primary')).toEqual([])
    expect(wrapEndpointFallback(captured, legacy).supportedThinkingLevels?.('primary')).toEqual([])
    expect(wrapEndpointFallback(captured, child).supportedThinkingLevels?.('primary')).toEqual(['high'])
    const fallback: LLMProvider = { ...legacy, supportedThinkingLevels(model) {
      expect(this).toBe(fallback); expect(model).toBe('actual-fallback'); return ['high']
    } }
    expect(wrapFallback(captured, fallback, { fallbackModel: 'actual-fallback' })
      .supportedThinkingLevels?.('primary')).toEqual(['high'])
  })
})
