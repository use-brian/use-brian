import { describe, expect, it, vi } from 'vitest'
import { createExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'
import { buildNativeApplicationGovernanceMcpTools, buildNativeApplicationSchemaMcpTools } from '../mcp.js'
import type { Pool } from 'pg'

const features = vi.hoisted(() => ({ previewApplicationSchema: vi.fn(), previewApplicationGovernance: vi.fn(), readApplicationGovernanceCatalog: vi.fn() }))
vi.mock('../schema-changes.js', async importOriginal => ({ ...await importOriginal<typeof import('../schema-changes.js')>(), previewApplicationSchema: features.previewApplicationSchema }))
vi.mock('../governance.js', async importOriginal => ({ ...await importOriginal<typeof import('../governance.js')>(), previewApplicationGovernance: features.previewApplicationGovernance, readApplicationGovernanceCatalog: features.readApplicationGovernanceCatalog }))

const userId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '10000000-0000-4000-8000-000000000002'
const assistantId = '10000000-0000-4000-8000-000000000003'
const typeId = '10000000-0000-4000-8000-000000000004'

/** Adapter effect classification only; canonical SQL authorization is covered by integration suites. */
describe('[COMP:api/application-management] persisted native preview MCP receipts', () => {
  function fixture() {
    let current = true
    const assertCurrent = async () => { if (!current) throw new AuthorityChangedError() }
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
