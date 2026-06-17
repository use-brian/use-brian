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
import type { Tool } from '@sidanclaw/core'

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
})
