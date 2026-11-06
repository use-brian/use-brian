import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildTool, createExecutionContext, executionToolContext, type ToolContext } from '@use-brian/core'
import { createAuthorityLease } from '../../context-scope/authority-lease.js'
import { readWorkspaceMcpConsent, snapshotWorkspaceMcpConsent, workspaceMcpMaximum } from '../consent.js'

const actor = '11111111-1111-4111-8111-111111111111'
const assistant = '22222222-2222-4222-8222-222222222222'
const workspace = '33333333-3333-4333-8333-333333333333'
const project = '44444444-4444-4444-8444-444444444444'
function fixture(readOnly = false) {
  const access = { workspaceId: workspace, userId: actor, assistantId: assistant, assistantKind: 'primary' as const,
    clearance: 'internal' as const, compartments: null, mutationCompartments: ['team:one'], projectIds: null,
    visibilityAssistantIds: null }
  const context: ToolContext = { ...executionToolContext(createExecutionContext({
    identity: { kind: 'programmatic', principal: { kind: 'assistant_key', credentialId: 'preview', actorUserId: actor }, credentialOwnerUserId: actor },
    ownership: { kind: 'workspace', workspaceId: workspace }, access, authority: createAuthorityLease(access, async () => access),
    writeDefaults: { compartments: [], projectIds: [] },
    lifecycle: { sessionId: 'preview', sessionPersisted: false, channelType: 'programmatic', channelId: 'preview', abortSignal: new AbortController().signal },
  }), { appId: assistant }), activeCapabilities: new Set() }
  const tool = (name: string, read: boolean, capability?: string) => buildTool({ name, description: name,
    inputSchema: z.object({}), isReadOnly: read, requiresCapability: capability, execute: async () => ({ data: 'ok' }) })
  const tools = new Map([tool('inspectNative', true), tool('editNative', false), tool('operatorNative', false, 'configure')].map(t => [t.name, t]))
  return { context, tools, readOnly, availableCompartments: ['team:one', 'team:two'], availableProjectIds: [project], availableAssistantIds: [assistant],
    contextGroupId: null, contextProjectId: null, expiresAt: new Date(Date.now() + 60_000) }
}

describe('[COMP:api/workspace-mcp] explicit operation consent', () => {
  it('snapshots available native work without using configure as a blanket write permission', () => {
    const input = fixture()
    const consent = snapshotWorkspaceMcpConsent(input)
    expect(consent.operationNames).toEqual(['editNative', 'inspectNative'])
    expect(consent.compartments).toEqual(['team:one', 'team:two'])
    expect(consent.mutationCompartments).toEqual(['team:one'])
    expect(consent.projectIds).toEqual([project])
    input.context.activeCapabilities = new Set(['configure'])
    input.availableCompartments.push('team:later')
    expect(consent.operationNames).not.toContain('operatorNative')
    expect(consent.compartments).not.toContain('team:later')
  })
  it('never delegates writes on a read-only connection', () => {
    expect(snapshotWorkspaceMcpConsent(fixture(true)).operationNames).toEqual(['inspectNative'])
  })
  it('keeps old keys legacy while malformed or expired consent refuses instead of falling back', () => {
    expect(readWorkspaceMcpConsent(undefined)).toBeNull()
    expect(readWorkspaceMcpConsent(null)).toBeNull()
    expect(() => readWorkspaceMcpConsent({ version: 1 })).toThrow('workspace_mcp_consent_unavailable')
    const consent = snapshotWorkspaceMcpConsent(fixture())
    expect(readWorkspaceMcpConsent(consent)).toEqual(consent)
    expect(() => readWorkspaceMcpConsent(consent, Date.parse(consent.expiresAt))).toThrow('workspace_mcp_consent_unavailable')
    expect(workspaceMcpMaximum(consent, workspace, actor)).toMatchObject({ userId: actor, workspaceId: workspace,
      clearance: 'internal', compartments: consent.compartments, mutationCompartments: ['team:one'] })
  })
})
