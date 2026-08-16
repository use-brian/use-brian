/**
 * Unit tests for the workflow MCP tool-registry bridge.
 * Component tag: [COMP:workflow/mcp-bridge].
 *
 * Mocks injectMcpTools. Verifies buildWorkflowToolRegistry: the
 * first-party map is shallow-copied (boot-time entries never mutated),
 * the no-user branch skips MCP entirely, the user branch delegates to
 * injectMcpTools and returns the map it mutated, and the run scope is
 * forwarded.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../mcp/inject.js', () => ({ injectMcpTools: vi.fn() }))

import { buildWorkflowToolRegistry, type WorkflowToolRegistryDeps } from '../mcp-bridge.js'
import { injectMcpTools, type McpInjectionResult } from '../../mcp/inject.js'
import type { Tool } from '@use-brian/core'

const mockInject = vi.mocked(injectMcpTools)

function makeDeps(firstParty: Map<string, Tool>): WorkflowToolRegistryDeps {
  return {
    firstParty,
    connectorStore: {},
    settingsStore: {},
  } as unknown as WorkflowToolRegistryDeps
}

const scope = {
  workspaceId: 'ws-1',
  assistantId: 'a-1',
  userId: 'u-1' as string | null,
}

beforeEach(() => {
  mockInject.mockReset()
})

describe('[COMP:workflow/mcp-bridge] buildWorkflowToolRegistry', () => {
  it('returns a shallow copy — mutating the result never touches the boot map', async () => {
    const firstParty = new Map<string, Tool>([['fp', {} as Tool]])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), { ...scope, userId: null })
    expect(out).not.toBe(firstParty)
    out.set('mutation', {} as Tool)
    expect(firstParty.has('mutation')).toBe(false)
  })

  it('skips MCP injection entirely when the run has no user', async () => {
    const firstParty = new Map<string, Tool>([['fp', {} as Tool]])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), { ...scope, userId: null })
    expect(mockInject).not.toHaveBeenCalled()
    expect([...out.keys()]).toEqual(['fp'])
  })

  it('delegates to injectMcpTools and returns the map it mutated when a user is present', async () => {
    mockInject.mockImplementationOnce(async (params) => {
      params.tools.set('mcp_added', {} as Tool)
      return { enrichConfirmation: () => undefined, unavailable: [] } as unknown as McpInjectionResult
    })
    const firstParty = new Map<string, Tool>([['fp', {} as Tool]])
    const out = await buildWorkflowToolRegistry(makeDeps(firstParty), scope)
    expect(mockInject).toHaveBeenCalledOnce()
    expect([...out.keys()].sort()).toEqual(['fp', 'mcp_added'])
  })

  it('forwards the run scope to injectMcpTools', async () => {
    await buildWorkflowToolRegistry(makeDeps(new Map<string, Tool>()), scope)
    const arg = mockInject.mock.calls[0][0]
    expect(arg.userId).toBe('u-1')
    expect(arg.assistantId).toBe('a-1')
    expect(arg.assistantTeamId).toBe('ws-1')
  })

  it('enables KB writes and forwards the repo writer — the executor approval pause is the gate', async () => {
    // Not a regression of the chat-only D2 decision: the gate moved rather
    // than disappeared. Both KB write tools declare `requiresConfirmation`,
    // and `keepBuiltinsDirect` keeps that flag visible to the executor, which
    // routes it into a `kind='workflow_step'` approval. Without this the
    // `knowledge` event source could only ever notify, never maintain.
    const writer = { commitEntryUpdate: vi.fn(), commitEntryCreate: vi.fn() }
    const deps = { ...makeDeps(new Map<string, Tool>()), knowledgeRepoWriter: writer } as WorkflowToolRegistryDeps
    await buildWorkflowToolRegistry(deps, scope)
    expect(mockInject.mock.calls[0][0].allowKnowledgeWrites).toBe(true)
    expect(mockInject.mock.calls[0][0].knowledgeRepoWriter).toBe(writer)
    // The executor can only see `requiresConfirmation` on a built-in that was
    // left directly in the map; routing it behind mcp_call would hide it.
    expect(mockInject.mock.calls[0][0].keepBuiltinsDirect).toBe(true)
    // Deterministic tool_call steps also need exact custom/CLI registry names.
    expect(mockInject.mock.calls[0][0].keepDynamicToolsDirect).toBe(true)
  })

  it('exposes no repo write path when the writer port is absent (open standalone boot)', async () => {
    await buildWorkflowToolRegistry(makeDeps(new Map<string, Tool>()), scope)
    expect(mockInject.mock.calls[0][0].knowledgeRepoWriter).toBeUndefined()
  })
})
