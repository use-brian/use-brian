import { describe, expect, it, vi } from 'vitest'
import { createExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'
import { buildNativeApplicationGovernanceMcpTools, buildNativeApplicationSchemaMcpTools, buildNativeApplicationManagementMcpTools } from '../mcp.js'
import type { Pool } from 'pg'
import { ApplicationManagementService, applicationManagementCommandSchema } from '../management.js'
import type { ApplicationPlatformService } from '../service.js'
import { executeApplicationLegacyReview } from '../legacy-review.js'

const features = vi.hoisted(() => ({ previewApplicationSchema: vi.fn(), previewApplicationGovernance: vi.fn(), readApplicationGovernanceCatalog: vi.fn() }))
vi.mock('../schema-changes.js', async importOriginal => ({ ...await importOriginal<typeof import('../schema-changes.js')>(), previewApplicationSchema: features.previewApplicationSchema }))
vi.mock('../governance.js', async importOriginal => ({ ...await importOriginal<typeof import('../governance.js')>(), previewApplicationGovernance: features.previewApplicationGovernance, readApplicationGovernanceCatalog: features.readApplicationGovernanceCatalog }))

const userId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '10000000-0000-4000-8000-000000000002'
const assistantId = '10000000-0000-4000-8000-000000000003'
const typeId = '10000000-0000-4000-8000-000000000004'

/** Adapter effect classification only; canonical SQL authorization is covered by integration suites. */
describe('[COMP:api/application-management] persisted native preview MCP receipts', () => {
  function fixture(operationMayHaveExecuted = false) {
    let current = true
    const assertCurrent = async () => { if (!current) throw new AuthorityChangedError(operationMayHaveExecuted) }
    const execution = createExecutionContext({
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId },
      access: { workspaceId, userId, assistantId, assistantKind: 'primary', clearance: 'confidential',
        compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null },
      writeDefaults: { compartments: [], projectIds: [] },
      authority: { assertCurrent, execute: async operation => { await assertCurrent(); return operation() } },
      lifecycle: { sessionId: typeId, sessionPersisted: false, channelType: 'test', channelId: 'preview-fixture', abortSignal: new AbortController().signal },
    })
    const previewSchema = features.previewApplicationSchema.mockReset().mockResolvedValue({ id: typeId, canApply: true })
    const previewGovernance = features.previewApplicationGovernance.mockReset().mockResolvedValue({ id: typeId, canApply: true })
    const governanceCatalog = features.readApplicationGovernanceCatalog.mockReset().mockResolvedValue({ roleKeys: [], nativeResourceTypes: [], configurationOperations: [] })
    const pool = { connect: vi.fn() } as unknown as Pool
    return { execution, pool, previewSchema, previewGovernance, governanceCatalog, revoke: () => { current = false } }
  }
  async function preview(kind: 'schema' | 'governance', value: ReturnType<typeof fixture>) {
    const tools = kind === 'schema' ? buildNativeApplicationSchemaMcpTools(value.pool, value.execution)
      : await buildNativeApplicationGovernanceMcpTools(value.pool, value.execution, 'native')
    const tool = tools.find(item => item.name === (kind === 'schema' ? 'applicationSchemaPreview' : 'applicationGovernancePreview'))!
    const input = kind === 'schema' ? { typeId, expectedVersion: 1, properties: [] }
      : { moduleKey: 'native', expectedRevision: 'a'.repeat(64), operation: { kind: 'bind_owner', entityTypeId: typeId } }
    return { tool, input }
  }
  function payload(result: Awaited<ReturnType<Awaited<ReturnType<typeof preview>>['tool']['handler']>>) {
    const content = result.content.find(item => item.type === 'text')!
    return JSON.parse((content as { text: string }).text)
  }
  it.each(['legacy.inventory', 'legacy.preview'])('rejects retired %s before SQL or authority lookup', async kind => {
    const value = fixture(), service = new ApplicationManagementService({} as ApplicationPlatformService, value.pool)
    const input = kind === 'legacy.inventory' ? {} : { resourceKind: 'memory', resourceIds: [typeId], action: 'release', reason: 'Fictional review' }
    expect(applicationManagementCommandSchema.safeParse({ kind, input }).success).toBe(false)
    await expect(service.executeCommand(userId, workspaceId, { kind, input })).rejects.toMatchObject({ code: 'invalid_value', effect: 'none' })
    expect(value.pool.connect).not.toHaveBeenCalled()
    const query = vi.fn()
    await expect(executeApplicationLegacyReview({ query } as never, value.execution, { kind, input } as never)).rejects.toMatchObject({ code: 'invalid_value', effect: 'none' })
    expect(query).not.toHaveBeenCalled()
  })
  it('admits only exact recovery envelopes and dispatches metadata view without authoring SQL', async () => {
    expect(applicationManagementCommandSchema.safeParse({ kind: 'legacy.view', reviewId: typeId }).success).toBe(true)
    for (const command of [
      { kind: 'legacy.view', reviewId: typeId, payloadHash: 'a'.repeat(64) },
      { kind: 'legacy.apply', reviewId: typeId, expectedVersion: 1, payloadHash: 'a'.repeat(64) },
      { kind: 'legacy.cancel', reviewId: typeId, expectedVersion: '0', payloadHash: 'a'.repeat(64) },
      { kind: 'legacy.apply', reviewId: typeId, expectedVersion: '1', payloadHash: 'A'.repeat(64) },
    ]) expect(applicationManagementCommandSchema.safeParse(command).success).toBe(false)
    const value = fixture(), metadata = { id: typeId, version: '1', payloadHash: 'a'.repeat(64), status: 'preview', items: [] }
    const query = vi.fn().mockResolvedValue({ rows: [{ value: metadata }] })
    expect(await executeApplicationLegacyReview({ query } as never, value.execution, { kind: 'legacy.view', reviewId: typeId } as never)).toEqual(metadata)
    expect(query.mock.calls.map(call => call[0])).toEqual([
      "SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",
      'SELECT application_legacy_review_view($1,$2,$3) AS value',
    ])
  })
  it.each(['legacy.view', 'legacy.apply', 'legacy.cancel'] as const)('keeps outer %s late revocation effect exact without leaking metadata', async kind => {
    const value = fixture(), executeCommand = vi.fn(async () => { await Promise.resolve(); value.revoke(); return { id: typeId, payloadHash: 'a'.repeat(64) } })
    const service = { executeCommand } as unknown as ApplicationManagementService
    const tool = buildNativeApplicationManagementMcpTools(service, value.execution).find(item => item.name === 'applicationManage')!
    const result = await tool.handler({ command: { kind, reviewId: typeId, ...(kind === 'legacy.view' ? {} : { expectedVersion: '1', payloadHash: 'a'.repeat(64) }) } })
    expect(payload(result)).toEqual({ error: 'grant_revoked', effect: kind === 'legacy.view' ? 'none' : 'committed', retrySafe: false })
    expect(executeCommand).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain(typeId)
  })
  it('keeps a metadata view effect-free when the original lease carries prior operation uncertainty', async () => {
    const value = fixture(true), executeCommand = vi.fn(async () => { value.revoke(); return { id: typeId } })
    const tool = buildNativeApplicationManagementMcpTools({ executeCommand } as unknown as ApplicationManagementService, value.execution).find(item => item.name === 'applicationManage')!
    expect(payload(await tool.handler({ command: { kind: 'legacy.view', reviewId: typeId } }))).toEqual({ error: 'grant_revoked', effect: 'none', retrySafe: false })
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })
  it.each(['legacy.apply', 'legacy.cancel'] as const)('preserves inherited %s uncertainty for a marked original lease', async kind => {
    const value = fixture(true), executeCommand = vi.fn().mockRejectedValue(new AuthorityChangedError(true))
    const tool = buildNativeApplicationManagementMcpTools({ executeCommand } as unknown as ApplicationManagementService, value.execution).find(item => item.name === 'applicationManage')!
    expect(payload(await tool.handler({ command: { kind, reviewId: typeId, expectedVersion: '1', payloadHash: 'a'.repeat(64) } }))).toEqual({ error: 'grant_revoked', effect: 'uncertain', retrySafe: false })
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })
  it('preserves an explicit platform uncertainty effect even for metadata view', async () => {
    const value = fixture(), executeCommand = vi.fn().mockRejectedValue(new ApplicationPlatformError('outcome_uncertain', 'Private exception', 'uncertain'))
    const tool = buildNativeApplicationManagementMcpTools({ executeCommand } as unknown as ApplicationManagementService, value.execution).find(item => item.name === 'applicationManage')!
    expect(payload(await tool.handler({ command: { kind: 'legacy.view', reviewId: typeId } }))).toEqual({ error: 'outcome_uncertain', effect: 'uncertain', retrySafe: false })
  })
  it.each(['legacy.apply', 'legacy.cancel'] as const)('preserves %s uncertainty without retry', async kind => {
    const value = fixture(), executeCommand = vi.fn().mockRejectedValue(new ApplicationPlatformError('outcome_uncertain', 'Private exception', 'uncertain'))
    const tool = buildNativeApplicationManagementMcpTools({ executeCommand } as unknown as ApplicationManagementService, value.execution).find(item => item.name === 'applicationManage')!
    const result = await tool.handler({ command: { kind, reviewId: typeId, expectedVersion: '1', payloadHash: 'a'.repeat(64) } })
    expect(payload(result)).toEqual({ error: 'outcome_uncertain', effect: 'uncertain', retrySafe: false }); expect(executeCommand).toHaveBeenCalledTimes(1)
  })
  it.each(['legacy.view', 'legacy.apply', 'legacy.cancel'] as const)('keeps inner %s current lease and effect exact', async kind => {
    const value = fixture(), service = new ApplicationManagementService({} as ApplicationPlatformService, value.pool)
    vi.spyOn(service as any, 'nativeSchemaExecution').mockResolvedValue(value.execution)
    const transaction = vi.spyOn(service as any, 'transaction').mockImplementation(async () => { await Promise.resolve(); value.revoke(); return { id: typeId } })
    const command = { kind, reviewId: typeId, ...(kind === 'legacy.view' ? {} : { expectedVersion: '1', payloadHash: 'a'.repeat(64) }) }
    await expect(service.executeCommand(userId, workspaceId, command)).rejects.toMatchObject({ code: 'grant_revoked', effect: kind === 'legacy.view' ? 'none' : 'committed' })
    expect(transaction.mock.calls[0][3]).toBe(kind !== 'legacy.view'); expect(transaction).toHaveBeenCalledTimes(1)
  })
  it.each(['schema', 'governance'] as const)('reports committed %s review when authority contracts after its successful await', async kind => {
    const value = fixture(), selected = await preview(kind, value)
    const savedReview = { id: typeId, canApply: true }
    const method = kind === 'schema' ? value.previewSchema : value.previewGovernance
    method.mockImplementationOnce(async () => { await Promise.resolve(); value.revoke(); return savedReview })
    const result = await selected.tool.handler(selected.input)
    expect(result.isError).toBe(true)
    expect(payload(result)).toEqual({ error: 'grant_revoked', effect: 'committed', retrySafe: false })
    expect(method).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result)).not.toContain(typeId)
  })
  it.each(['schema', 'governance'] as const)('preserves an uncertain %s review without retry or leaked exception', async kind => {
    const value = fixture(), selected = await preview(kind, value)
    const method = kind === 'schema' ? value.previewSchema : value.previewGovernance
    method.mockRejectedValueOnce(new ApplicationPlatformError('outcome_uncertain', 'Private database exception', 'uncertain'))
    const result = await selected.tool.handler(selected.input)
    expect(result.isError).toBe(true)
    expect(payload(result)).toEqual({ error: 'outcome_uncertain', effect: 'uncertain', retrySafe: false })
    expect(method).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain('Private database exception')
  })
  it.each(['schema', 'governance'] as const)('does not start a %s review after failed preflight', async kind => {
    const value = fixture(), selected = await preview(kind, value)
    value.revoke()
    const result = await selected.tool.handler(selected.input)
    expect(result.isError).toBe(true)
    expect(payload(result)).toEqual({ error: 'grant_revoked', effect: 'none', retrySafe: false })
    expect(value.previewSchema).not.toHaveBeenCalled(); expect(value.previewGovernance).not.toHaveBeenCalled()
  })
  it.each(['schema', 'governance'] as const)('returns the admitted %s review once when current', async kind => {
    const value = fixture(), selected = await preview(kind, value)
    const result = await selected.tool.handler(selected.input)
    expect(result.isError).not.toBe(true); expect(payload(result)).toEqual({ id: typeId, canApply: true })
    expect(kind === 'schema' ? value.previewSchema : value.previewGovernance).toHaveBeenCalledTimes(1)
    const method = kind === 'schema' ? value.previewSchema : value.previewGovernance
    expect(method.mock.calls[0].slice(0, 2)).toEqual([value.pool, value.execution])
  })
})
