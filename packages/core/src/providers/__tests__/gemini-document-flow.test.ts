import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiProvider } from '../gemini.js'
import { debugDocumentFlow, withDocumentFlowDebug } from '../../engine/document-flow-debug.js'
import type { StreamChunk } from '../types.js'

const secret = 'PRIVATE https://private.example/key raw-id PDF-content'
const names = ['listDocumentExtractionConnectors', 'prepareDocumentExtraction', 'startDocumentExtraction', 'readDocumentExtraction', 'proposeOfficeEvidenceFill', 'mcp_search', 'mcp_call']
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it.each([false, true])('logs final Gemini body metadata and correlation (stateful=%s)', async stateful => {
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const bodies: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`)
  }))
  const provider = createGeminiProvider(secret)
  const options = { model: 'gemini-3.8-flash', systemPrompt: secret, tools: [...names, secret].map(name => ({ name, description: secret, parameters: { type: 'object' as const, properties: {}, description: secret } })) }
  const messages = [{ role: 'user' as const, content: secret }]
  async function* run(): AsyncGenerator<StreamChunk> {
    if (stateful) {
      const session = provider.createSession!(options)
      yield* session.send(messages)
      yield* session.send(messages)
    } else {
      yield* provider.stream({ ...options, messages })
      yield* provider.stream({ ...options, tools: [], messages })
    }
  }
  for await (const _ of withDocumentFlowDebug(secret, run())) { /* drain */ }
  const rows = log.mock.calls.filter(([prefix]) => prefix === '[document-flow-debug]').map(([, json]) => JSON.parse(json))
  expect(rows).toHaveLength(2)
  for (const [i, row] of rows.entries()) {
    expect(row.session).toMatch(/^[a-f0-9]{16}$/)
    expect(row.session).toBe(rows[0].session)
    expect(row.mode).toBe(stateful ? 'stateful_delta' : 'stateless_full')
    const total = bodies[i].tools?.[0].functionDeclarations.length ?? 0
    expect(row.gemini).toMatchObject({ cached: false, declarationSource: 'inline', effectiveKnown: true, effective: { total }, toolChoiceMode: total ? 'AUTO' : 'omitted' })
    expect(row.gemini.effective.presence).toEqual(Object.fromEntries(names.map(name => [name, total > 0])))
  }
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE')
})

it('distinguishes disabled choice from declarations and unknown cached tools from absence', () => {
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', '1')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  for (const mode of ['NONE', 'ANY', secret]) debugDocumentFlow('gemini_wire', { gemini: {
    tools: [{ functionDeclarations: [{ name: names[0]! }] }], toolConfig: { functionCallingConfig: { mode } },
  } })
  debugDocumentFlow('gemini_wire', { gemini: { cachedContent: secret } })
  const rows = log.mock.calls.map(([, json]) => JSON.parse(json).gemini)
  expect(rows[0]).toMatchObject({ toolChoiceMode: 'NONE', effective: { total: 1, presence: { listDocumentExtractionConnectors: true } } })
  expect(rows[1].toolChoiceMode).toBe('ANY')
  expect(rows[2].toolChoiceMode).toBe('other')
  expect(rows[3]).toMatchObject({ cached: true, declarationSource: 'cached', effectiveKnown: false, effective: null })
  expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
})

it.each([undefined, '0', 'true'])('does not inspect tool metadata when disabled (%s)', value => {
  vi.stubEnv('BRIAN_DEBUG_DOCUMENT_FLOW', value)
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  debugDocumentFlow('gemini_wire', { get gemini(): never { throw new Error('inspected') } })
  debugDocumentFlow('tool_availability', { get declarations(): never { throw new Error('inspected') } })
  expect(log).not.toHaveBeenCalled()
})
