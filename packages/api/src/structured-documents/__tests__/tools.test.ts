import { connectorInstanceId } from './connector-helper.js'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { createStructuredDocumentTools, trustedToolContext } from '../tools.js'
import { StructuredDocumentServiceError, type StructuredDocumentService } from '../service.js'
const uid = (n: number) => `49000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function context(): ToolContext {
  return { userId: uid(1), assistantId: uid(3), workspaceId: uid(2), sessionId: uid(30), abortSignal: new AbortController().signal, appId: 'fictional', channelType: 'web', channelId: uid(31),
    assistantKind: 'standard', clearance: 'confidential', compartments: ['team-a'], projectIds: ['project-a'], activeCapabilities: new Set(['files', 'office']) }
}
function setup() {
  const scopeEvidence = { sensitivity: 'internal' as const, compartments: ['team-a'], projectIds: ['project-a'] }
  const calls = {
    listConnectors: vi.fn(async () => ({ connectors: [], scopeEvidence })),
    prepare: vi.fn(async () => ({ extractionId: uid(7), scopeEvidence })),
    start: vi.fn(async () => ({ extractionId: uid(7), status: 'queued', scopeEvidence })),
    read: vi.fn(async () => ({ extractionId: uid(7), total: 3, nextOffset: 2, data: [{ id: 'evidence' }], scopeEvidence })),
    propose: vi.fn(async () => ({ proposalId: uid(20), requiresHumanReview: true, scopeEvidence })),
  }
  const service = calls as unknown as StructuredDocumentService
  const resolvePolicy = vi.fn(async (_name: string, _ctx: ToolContext): Promise<'allow' | 'ask' | 'block'> => 'allow')
  const tools = createStructuredDocumentTools({ service, resolvePolicy })
  return { tools, calls, resolvePolicy, scopeEvidence, tool: (name: string) => tools.find(t => t.name === name)! }
}
const mapping = { targetId: uid(9), source: { kind: 'cell', recordId: 'r1', cellId: 'c1' }, meaning: 'Account ID', reason: 'Selected observation' }
const inputs = {
  listDocumentExtractionConnectors: {},
  prepareDocumentExtraction: { fileId: uid(4), connectorInstanceId },
  startDocumentExtraction: { extractionId: uid(7) },
  readDocumentExtraction: { extractionId: uid(7), view: 'records', offset: 0, limit: 2 },
  proposeOfficeEvidenceFill: { extractionId: uid(7), artifactId: uid(8), expectedVersion: 3, mappings: [mapping] },
}

describe('[COMP:files/structured-document-tools] source-reference-only tools', () => {
  it('registers exactly the five capability-scoped tools with appropriate effects', () => {
    const f = setup()
    expect(f.tools.map(t => t.name)).toEqual(Object.keys(inputs))
    for (const t of f.tools) {
      expect(t.requiresCapability).toBe(t.name === 'proposeOfficeEvidenceFill' ? 'office' : 'files')
      expect(t.isReadOnly).toBe(['readDocumentExtraction', 'listDocumentExtractionConnectors'].includes(t.name))
      expect(t.allowPersistentApproval).toBe(false)
    }
    expect(f.tool('startDocumentExtraction').requiresConfirmation).toBe(false)
  })
  it('honors allow, ask and block for every tool including start', async () => {
    const f = setup(), ctx = context()
    for (const t of f.tools) await expect(t.resolveConfirmation!(ctx)).resolves.toBe(false)
    f.resolvePolicy.mockResolvedValue('ask')
    for (const t of f.tools) await expect(t.resolveConfirmation!(ctx)).resolves.toBe(true)
    f.resolvePolicy.mockResolvedValue('block')
    for (const t of f.tools) {
      await expect(t.resolveConfirmation!(ctx)).rejects.toMatchObject({ code: 'access_denied' })
      expect(await t.execute(inputs[t.name as keyof typeof inputs], ctx)).toMatchObject({ isError: true, data: { code: 'policy_blocked' } })
    }
    for (const call of Object.values(f.calls)) expect(call).not.toHaveBeenCalled()
  })
  it('policy errors block both confirmation and execution without leaking diagnostics', async () => {
    const f = setup(), ctx = context()
    f.resolvePolicy.mockRejectedValue(new Error('token-secret vendor-body'))
    for (const t of f.tools) {
      await expect(t.resolveConfirmation!(ctx)).rejects.toMatchObject({ code: 'access_denied' })
      const result = await t.execute(inputs[t.name as keyof typeof inputs], ctx)
      expect(result).toMatchObject({ isError: true, data: { code: 'policy_blocked' } })
      expect(JSON.stringify(result)).not.toMatch(/token-secret|vendor-body/)
    }
    for (const call of Object.values(f.calls)) expect(call).not.toHaveBeenCalled()
  })
  it.each(['prepareDocumentExtraction', 'startDocumentExtraction'] as const)('rechecks %s policy at execution after an earlier allow', async name => {
    const f = setup(), ctx = context(), t = f.tool(name)
    await t.resolveConfirmation!(ctx)
    f.resolvePolicy.mockResolvedValue('block')
    expect(await t.execute(inputs[name], ctx)).toMatchObject({ isError: true, data: { code: 'policy_blocked' } })
    expect(f.calls.prepare).not.toHaveBeenCalled()
    expect(f.calls.start).not.toHaveBeenCalled()
  })
  it('requires Files for every tool and Office additionally for the proposal', async () => {
    const f = setup(), ctx = context()
    ctx.activeCapabilities = new Set(['office'])
    for (const t of f.tools) expect(await t.execute(inputs[t.name as keyof typeof inputs], ctx)).toMatchObject({ isError: true, data: { code: 'capability_required' } })
    ctx.activeCapabilities = new Set(['files'])
    expect(await f.tool('proposeOfficeEvidenceFill').execute(inputs.proposeOfficeEvidenceFill, ctx)).toMatchObject({ isError: true })
    expect(await f.tool('prepareDocumentExtraction').execute(inputs.prepareDocumentExtraction, ctx)).not.toHaveProperty('isError')
    delete ctx.activeCapabilities
    expect(await f.tool('readDocumentExtraction').execute(inputs.readDocumentExtraction, ctx)).toMatchObject({ isError: true })
  })
  it('uses only trusted context fields, with absent scopes as empty and explicit null as universe', () => {
    const ctx = context()
    Object.assign(ctx, { writeCompartments: ['invented-write'], assistantCompartments: null, assistantProjectIds: null, systemRead: true })
    const trusted = trustedToolContext(ctx)
    expect(trusted).toEqual({ userId: uid(1), workspaceId: uid(2), assistantId: uid(3), assistantKind: 'standard', clearance: 'confidential', compartments: ['team-a'], projectIds: ['project-a'] })
    delete ctx.compartments; delete ctx.projectIds
    expect(trustedToolContext(ctx)).toMatchObject({ compartments: [], projectIds: [] })
    ctx.compartments = null; ctx.projectIds = null
    expect(trustedToolContext(ctx)).toMatchObject({ compartments: null, projectIds: null })
    const inherited = Object.assign(Object.create({ compartments: null, projectIds: null }), { ...ctx })
    delete inherited.compartments; delete inherited.projectIds
    expect(trustedToolContext(inherited)).toMatchObject({ compartments: [], projectIds: [] })
  })
  it('forwards strict parsed inputs and source scope evidence separately from model data', async () => {
    const f = setup(), ctx = context()
    for (const t of f.tools) {
      const result = await t.execute(inputs[t.name as keyof typeof inputs], ctx)
      expect(result.scopeEvidence).toEqual(f.scopeEvidence)
      expect(result.data).not.toHaveProperty('scopeEvidence')
    }
    expect(f.calls.prepare).toHaveBeenCalledWith(trustedToolContext(ctx), inputs.prepareDocumentExtraction)
    expect(f.calls.start).toHaveBeenCalledWith(trustedToolContext(ctx), inputs.startDocumentExtraction)
    expect(f.calls.read).toHaveBeenCalledWith(trustedToolContext(ctx), inputs.readDocumentExtraction)
    expect(f.calls.propose).toHaveBeenCalledWith(trustedToolContext(ctx), inputs.proposeOfficeEvidenceFill)
  })
  it('rejects caller-selected endpoints, scope overrides, literal values and nested authority fields', async () => {
    const f = setup(), ctx = context()
    for (const extra of [{ baseUrl: 'https://attacker.invalid' }, { token: 'secret' }, { userId: uid(99) }, { compartments: null }, { pdf: 'model bytes' }]) {
      expect(await f.tool('prepareDocumentExtraction').execute({ ...inputs.prepareDocumentExtraction, ...extra }, ctx)).toMatchObject({ isError: true, data: { code: 'invalid_request' } })
    }
    for (const m of [
      { ...mapping, value: 999 }, { ...mapping, formula: '=BAD()' }, { ...mapping, source: { ...mapping.source, rawText: 'invented' } },
      { ...mapping, source: { kind: 'literal', value: 'invented' } },
    ]) expect(await f.tool('proposeOfficeEvidenceFill').execute({ ...inputs.proposeOfficeEvidenceFill, mappings: [m] }, ctx)).toMatchObject({ isError: true, data: { code: 'invalid_request' } })
    expect(f.calls.prepare).not.toHaveBeenCalled(); expect(f.calls.propose).not.toHaveBeenCalled()
  })
  it.each([{ limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 0.5 }, { view: 'raw-all' }])('rejects unbounded/invalid pagination %j', async patch => {
    const f = setup()
    expect(await f.tool('readDocumentExtraction').execute({ ...inputs.readDocumentExtraction, ...patch }, context())).toMatchObject({ isError: true, data: { code: 'invalid_request' } })
    expect(f.calls.read).not.toHaveBeenCalled()
  })
  it.each([
    'connector_health_approval_required', 'connector_policy_blocked', 'connector_unavailable',
    'connector_configuration_invalid', 'connector_changed', 'invalid_context', 'connector_limit_exceeded',
    'source_storage_unavailable', 'extraction_schema_missing', 'extraction_store_unavailable',
  ] as const)('propagates safe preflight error %s without generic flattening', async code => {
    const f = setup()
    const error = Object.assign(new StructuredDocumentServiceError(code), {
      detail: 'fictional-token-sentinel https://fictional.invalid/private PDF-text-sentinel',
      values: ['fictional-token-sentinel', 'PDF-text-sentinel'],
    })
    f.calls.prepare.mockRejectedValue(error)
    const result = await f.tool('prepareDocumentExtraction').execute(inputs.prepareDocumentExtraction, context())
    expect(result).toMatchObject({ isError: true, data: { code, message: error.message } })
    expect(error.message.length).toBeGreaterThan(0)
    expect(JSON.stringify(result)).not.toMatch(/fictional-token-sentinel|fictional\.invalid|PDF-text-sentinel/)
  })
  it('returns safe actionable domain errors and sanitizes unexpected boundary exceptions', async () => {
    const f = setup(), ctx = context()
    f.calls.read.mockRejectedValue(new StructuredDocumentServiceError('source_changed'))
    expect(await f.tool('readDocumentExtraction').execute(inputs.readDocumentExtraction, ctx)).toMatchObject({ isError: true, data: { code: 'source_changed', message: 'The source file or its scope changed. Prepare a new extraction.' } })
    f.calls.read.mockRejectedValue(new Error('vendor-body credential-secret'))
    const result = await f.tool('readDocumentExtraction').execute(inputs.readDocumentExtraction, ctx)
    expect(result).toMatchObject({ isError: true, data: { code: 'operation_failed' } })
    expect(JSON.stringify(result)).not.toMatch(/vendor-body|credential-secret/)
  })
})
