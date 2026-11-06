import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  buildTool, createExecutionContext, executionToolContext, ContextScopeAccumulator,
  type Tool, type ToolContext,
} from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { currentAgentAccess } from '../../db/agent-access-context.js'
import { buildWorkspaceMcpCatalog } from '../catalog.js'

function fixture(tools: Tool[]) {
  let active = true
  const access = {
    workspaceId: 'workspace-1', userId: 'issuer-1', assistantId: 'assistant-1',
    assistantKind: 'standard' as const, clearance: 'internal' as const,
    compartments: ['engineering'], mutationCompartments: ['engineering'],
    projectIds: ['project-1'], visibilityAssistantIds: ['assistant-1'],
  }
  const authority = createAuthorityLease(access, async () => active ? access : null)
  const execution = createExecutionContext({
    identity: { kind: 'programmatic', principal: {
      kind: 'assistant_key', credentialId: 'key-1', actorUserId: 'issuer-1',
    }, credentialOwnerUserId: 'owner-1' },
    ownership: { kind: 'workspace', workspaceId: access.workspaceId }, access, authority,
    writeDefaults: { compartments: ['engineering'], projectIds: ['project-1'] },
    lifecycle: { sessionId: 'request-1', sessionPersisted: false,
      channelType: 'assistant_mcp', channelId: 'key-1', abortSignal: new AbortController().signal },
  })
  const context: ToolContext = {
    ...executionToolContext(execution, { appId: 'assistant-1' }),
    activeCapabilities: new Set(['tasks', 'home_app:tasks:read', 'home_app:tasks:write']), scopeAccumulator: new ContextScopeAccumulator(),
  }
  const admission = {
    context, tools: new Map(tools.map(tool => [tool.name, tool])),
    operationNames: new Set(tools.map(tool => tool.name)), readOnly: false,
  }
  return { admission, resolve: async () => admission, revoke: () => { active = false } }
}

function operation(overrides: Partial<Tool> = {}): Tool {
  return buildTool({
    name: 'saveTask', description: 'Create an admitted task.',
    inputSchema: z.object({ title: z.string().min(1), sensitivity: z.string().optional() }),
    isReadOnly: false, requiresConfirmation: false, requiresCapability: 'tasks',
    async execute(input, context) {
      expect(currentAgentAccess()?.userId).toBe('issuer-1')
      expect(context.workspaceActorUserId).toBeUndefined()
      expect(context.sessionPersisted).toBe(false)
      return { data: { id: 'task-1', title: input.title }, meta: { secretDiagnostic: 'not public' } }
    },
    ...overrides,
  })
}

describe('[COMP:api/workspace-mcp] native operation catalog', () => {
  it('uses canonical execution identity and preserves structured data without internal metadata', async () => {
    const f = fixture([operation()])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    const result = await tool!.handler({ title: 'Prepare fictional demo' })
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({ status: 'succeeded', data: { id: 'task-1', title: 'Prepare fictional demo' } })
    expect(JSON.stringify(result)).not.toContain('secretDiagnostic')
  })

  it('preserves native image previews alongside the structured result', async () => {
    const f = fixture([operation({ isReadOnly: true, execute: async () => ({
      data: { page: 1 }, images: [{ mimeType: 'image/png', data: 'fictional-preview-bytes' }],
    }) })])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    const result = await tool!.handler({ title: 'Test' })
    expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: 'fictional-preview-bytes' })
    expect(result.structuredContent).toMatchObject({ status: 'succeeded', data: { page: 1 } })
  })

  it('intersects explicit consent, read-only scope and assistant capability at discovery', async () => {
    const f = fixture([operation(), operation({ name: 'getTask', isReadOnly: true }),
      operation({ name: 'adminRead', isReadOnly: true, requiresCapability: 'configure' })])
    f.admission.readOnly = true
    expect((await buildWorkspaceMcpCatalog(f.resolve)).map(tool => tool.name)).toEqual(['getTask'])
    f.admission.operationNames = new Set()
    expect(await buildWorkspaceMcpCatalog(f.resolve)).toEqual([])
  })

  it('rechecks consent after discovery and cannot call an unlisted operation', async () => {
    const execute = vi.fn(async () => ({ data: 'changed' }))
    const f = fixture([operation({ execute })])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    f.admission.operationNames = new Set()
    expect(await tool!.handler({ title: 'Test' })).toMatchObject({ isError: true, structuredContent: { code: 'operation_unavailable' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('checks native write ceilings rather than directly executing the tool', async () => {
    const execute = vi.fn(async () => ({ data: 'changed' }))
    const f = fixture([operation({ execute })])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    const result = await tool!.handler({ title: 'Test', sensitivity: 'confidential' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('sensitivity_exceeds_clearance')
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects invalid arguments before producing a confirmation', async () => {
    const execute = vi.fn(async () => ({ data: 'changed' }))
    const f = fixture([operation({ execute, requiresConfirmation: true })])
    const createApproval = vi.fn(async () => 'approval-1')
    f.admission.context.createToolInvocationApproval = createApproval
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    expect(await tool!.handler({ title: '' })).toMatchObject({ isError: true, structuredContent: { code: 'invalid_input' } })
    expect(createApproval).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('parks Ask operations through native approval and reports pending, never success', async () => {
    const execute = vi.fn(async () => ({ data: 'sent' }))
    const f = fixture([operation({ execute, resolveConfirmation: async () => true })])
    f.admission.context.createToolInvocationApproval = vi.fn(async () => 'approval-1')
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    const result = await tool!.handler({ title: 'Test' })
    expect(result.structuredContent).toEqual({ status: 'waiting_approval', approvalId: 'approval-1' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports staged native approvals as pending without interpreting prose', async () => {
    const f = fixture([operation({ execute: async () => ({
      data: 'Prepared for review.', continuation: { kind: 'approval', approvalId: 'staged-1' },
    }) })])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    expect(await tool!.handler({ title: 'Test' })).toMatchObject({
      structuredContent: { status: 'waiting_approval', approvalId: 'staged-1' },
    })
  })

  it('refuses Ask without an approval port and cannot fabricate human presence', async () => {
    const execute = vi.fn(async () => ({ data: 'sent' }))
    const f = fixture([operation({ execute, requiresConfirmation: true })])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    expect(await tool!.handler({ title: 'Test', approved: true })).toMatchObject({ isError: true })
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not expose a completed result after authority is revoked during execution', async () => {
    const f = fixture([])
    const execute = vi.fn(async () => { f.revoke(); return { data: 'protected result' } })
    f.admission.tools = new Map([['saveTask', operation({ execute })]])
    f.admission.operationNames = new Set(['saveTask'])
    const [tool] = await buildWorkspaceMcpCatalog(f.resolve)
    const result = await tool!.handler({ title: 'Test' })
    expect(result.isError).toBe(true)
    expect(execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('protected result')
    expect(JSON.stringify(result)).toContain('Check its outcome before retrying')
  })
})

describe('[COMP:api/workspace-mcp] compact operation discovery', () => {
  async function compact(operations: Tool[] = [operation()]) {
    const f = fixture(operations)
    const executeOperation = vi.fn(async (invocation: { execute: () => Promise<unknown> }) => invocation.execute())
    const admission = { ...f.admission, executeOperation }
    const resolve = async () => admission
    const catalog = await buildWorkspaceMcpCatalog(resolve as Parameters<typeof buildWorkspaceMcpCatalog>[0])
    const helper = (name: string) => catalog.find(tool => tool.name === name)!
    const schema = async (name = 'saveTask') => (await helper('getWorkspaceOperationSchema').handler({ name })).structuredContent!.data as { schemaRevision: string; inputSchema: unknown }
    return { ...f, admission, executeOperation, helper, schema, resolve }
  }

  it('returns exact schemas and calls the canonical operation with the original receipt identity', async () => {
    const f = await compact()
    const detail = await f.schema()
    expect(detail.inputSchema).toMatchObject({ properties: { title: { type: 'string', minLength: 1 } } })
    const result = await f.helper('callWorkspaceOperation').handler({ name: 'saveTask', schemaRevision: detail.schemaRevision, arguments: { title: 'Fictional work' } }, { operationId: 'receipt-id' })
    expect(result).toMatchObject({ isError: false, structuredContent: { data: { title: 'Fictional work' } } })
    expect(f.executeOperation).toHaveBeenCalledOnce()
    expect(f.executeOperation.mock.calls[0]![0]).toMatchObject({ name: 'saveTask', input: { title: 'Fictional work' }, operationId: 'receipt-id' })
  })

  it('keeps read-only consent and capability-hidden tools out of search, detail and dispatch', async () => {
    const f = await compact([operation(), operation({ name: 'getTask', isReadOnly: true }), operation({ name: 'restricted', requiresCapability: 'configure', isReadOnly: true })])
    f.admission.readOnly = true
    expect(await f.helper('searchWorkspaceOperations').handler({})).toMatchObject({ structuredContent: { data: { operations: [{ name: 'getTask' }] } } })
    for (const name of ['saveTask', 'restricted', 'callWorkspaceOperation']) {
      expect(await f.helper('getWorkspaceOperationSchema').handler({ name })).toMatchObject({ isError: true, structuredContent: { code: 'operation_unavailable' } })
      expect(await f.helper('callWorkspaceOperation').handler({ name, schemaRevision: '0'.repeat(64), arguments: {} })).toMatchObject({ isError: true })
    }
    expect(f.executeOperation).not.toHaveBeenCalled()
  })

  it('refuses changed schemas and revoked operations before their effects', async () => {
    const execute = vi.fn(async () => ({ data: 'changed' }))
    const f = await compact([operation({ execute })])
    const detail = await f.schema()
    f.admission.tools.set('saveTask', operation({ execute, inputSchema: z.object({ title: z.string(), priority: z.number() }) }))
    const args = { name: 'saveTask', schemaRevision: detail.schemaRevision, arguments: { title: 'Fictional work' } }
    expect(await f.helper('callWorkspaceOperation').handler(args)).toMatchObject({ isError: true, structuredContent: { code: 'schema_changed' } })
    f.admission.operationNames.clear()
    expect(await f.helper('callWorkspaceOperation').handler(args)).toMatchObject({ isError: true, structuredContent: { code: 'operation_unavailable' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rechecks the schema at execution after compact lookup', async () => {
    const execute = vi.fn(async () => ({ data: 'changed' }))
    const f = await compact([operation({ execute })])
    const detail = await f.schema()
    f.executeOperation.mockImplementationOnce(async invocation => {
      f.admission.tools.set('saveTask', operation({ execute, description: 'Changed operation contract.' }))
      return invocation.execute()
    })
    const response = await f.helper('callWorkspaceOperation').handler({ name: 'saveTask', schemaRevision: detail.schemaRevision, arguments: { title: 'Fictional work' } })
    expect(response).toMatchObject({ isError: true, structuredContent: { code: 'schema_changed' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('binds search cursors to the exact query and current catalog', async () => {
    const f = await compact(Array.from({ length: 55 }, (_, index) => operation({ name: `task${String(index).padStart(2, '0')}`, isReadOnly: true })))
    const first = await f.helper('searchWorkspaceOperations').handler({ query: 'task', limit: 50 })
    const data = first.structuredContent!.data as { operations: unknown[]; nextCursor: string }
    expect(data.operations).toHaveLength(50)
    const second = await f.helper('searchWorkspaceOperations').handler({ query: 'task', cursor: data.nextCursor })
    expect((second.structuredContent!.data as { operations: unknown[] }).operations).toHaveLength(5)
    expect(await f.helper('searchWorkspaceOperations').handler({ query: 'other', cursor: data.nextCursor })).toMatchObject({ isError: true })
    f.admission.operationNames.delete('task00')
    expect(await f.helper('searchWorkspaceOperations').handler({ query: 'task', cursor: data.nextCursor })).toMatchObject({ isError: true })
  })

  it('preserves native Ask and does not interpret the dispatcher as approval', async () => {
    const execute = vi.fn(async () => ({ data: 'sent' }))
    const f = await compact([operation({ execute, requiresConfirmation: true })])
    f.admission.context.createToolInvocationApproval = vi.fn(async () => 'approval-compact')
    const detail = await f.schema()
    const result = await f.helper('callWorkspaceOperation').handler({ name: 'saveTask', schemaRevision: detail.schemaRevision, arguments: { title: 'Fictional work' } })
    expect(result).toMatchObject({ structuredContent: { status: 'waiting_approval', approvalId: 'approval-compact' } })
    expect(execute).not.toHaveBeenCalled()
  })
})
