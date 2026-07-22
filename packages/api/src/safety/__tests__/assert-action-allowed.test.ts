/**
 * Tests for the connector capability grant gate.
 * Component tag: [COMP:safety/assert-action-allowed].
 *
 * Covers the four boundary conditions the runtime depends on:
 *   1. No grant row → denied (the secure default for fresh assistants).
 *   2. Grant row exists but actionKind not in allowedActions → denied.
 *   3. Grant row exists with actionKind allowed → ok.
 *   4. The actor identity does NOT influence the decision — the gate
 *      uses `getForAssistantSystem` because the acting user is whoever
 *      sent the message, not the assistant owner.
 */

import { describe, it, expect, vi } from 'vitest'
import type { Tool } from '@use-brian/core'
import { assertActionAllowed, gateToolsOnActionGrants } from '../assert-action-allowed.js'
import type { AssistantConnectorGrantsStore } from '../../db/assistant-connector-grants-store.js'

function buildStore(
  getResult: Awaited<ReturnType<AssistantConnectorGrantsStore['getForAssistantSystem']>>,
): AssistantConnectorGrantsStore {
  return {
    getForAssistantSystem: vi.fn().mockResolvedValue(getResult),
    listForAssistant: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  }
}

describe('[COMP:safety/assert-action-allowed] grant gate', () => {
  it('denies when no grant row exists (secure default)', async () => {
    const store = buildStore(null)
    const res = await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('action_not_granted')
  })

  it('denies when the action is not in allowedActions', async () => {
    const store = buildStore({
      id: 'g-1',
      assistantId: 'a-1',
      connectorId: 'gmail',
      readAllowed: true,
      allowedActions: ['gmailMarkRead'],
      grantedByUserId: 'u-1',
      grantedAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('action_not_granted')
  })

  it('allows when the action is granted', async () => {
    const store = buildStore({
      id: 'g-1',
      assistantId: 'a-1',
      connectorId: 'gmail',
      readAllowed: true,
      allowedActions: ['gmailSendMessage'],
      grantedByUserId: 'u-1',
      grantedAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(res.ok).toBe(true)
  })

  it('uses the system-level getter so the acting user does not influence the decision', async () => {
    const store = buildStore(null)
    await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(store.getForAssistantSystem).toHaveBeenCalledWith('a-1', 'gmail')
  })
})

// ── gateToolsOnActionGrants — the registry-derived tool-set wrapper ──

function fakeTool(name: string): { tool: Tool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockResolvedValue({ data: `${name}-ran` })
  return { tool: { name, description: name, inputSchema: {} as never, execute } as unknown as Tool, execute }
}

describe('[COMP:safety/assert-action-allowed] gateToolsOnActionGrants', () => {
  it('gates every registry write/destructive tool of the connector, and only those', async () => {
    const store = buildStore(null) // no grant row → all writes denied
    const { tool: read } = fakeTool('githubListIssues')
    const { tool: write1 } = fakeTool('githubCreateIssue')
    const { tool: write2 } = fakeTool('githubWriteFile')
    const { tool: unknown } = fakeTool('someUnregisteredTool')

    const gated = gateToolsOnActionGrants([read, write1, write2, unknown], 'github', store, 'a-1')

    // Read + unregistered pass through and still run.
    await expect(gated[0].execute({} as never, {} as never)).resolves.toEqual({ data: 'githubListIssues-ran' })
    await expect(gated[3].execute({} as never, {} as never)).resolves.toEqual({ data: 'someUnregisteredTool-ran' })
    // Both registry write tools are denied before their execute runs.
    await expect(gated[1].execute({} as never, {} as never)).rejects.toThrow(/no grant for github/)
    await expect(gated[2].execute({} as never, {} as never)).rejects.toThrow(/no grant for github/)
  })

  it('does not run the underlying execute when the action is denied', async () => {
    const store = buildStore(null)
    const { tool, execute } = fakeTool('notionCreatePage')
    const [gated] = gateToolsOnActionGrants([tool], 'notion', store, 'a-1')
    await expect(gated.execute({} as never, {} as never)).rejects.toThrow(/action|grant/i)
    expect(execute).not.toHaveBeenCalled()
  })

  it('runs the underlying execute when the action is granted', async () => {
    const store = buildStore({
      id: 'g-1',
      assistantId: 'a-1',
      connectorId: 'gcal',
      readAllowed: true,
      allowedActions: ['googleTasksCreateTask'],
      grantedByUserId: 'u-1',
      grantedAt: new Date(),
      updatedAt: new Date(),
    })
    const { tool, execute } = fakeTool('googleTasksCreateTask')
    const [gated] = gateToolsOnActionGrants([tool], 'gcal', store, 'a-1')
    await expect(gated.execute({ x: 1 } as never, {} as never)).resolves.toEqual({ data: 'googleTasksCreateTask-ran' })
    expect(execute).toHaveBeenCalledWith({ x: 1 }, {})
  })

  it('returns the set unchanged when no store is wired (legacy call sites)', async () => {
    const { tool } = fakeTool('gmailSendMessage')
    const gated = gateToolsOnActionGrants([tool], 'gmail', undefined, 'a-1')
    expect(gated[0]).toBe(tool)
  })

  it('returns the set unchanged for connectors with no registry write tools', async () => {
    const store = buildStore(null)
    const { tool } = fakeTool('fathomListMeetings')
    const gated = gateToolsOnActionGrants([tool], 'fathom', store, 'a-1')
    expect(gated[0]).toBe(tool)
    expect(store.getForAssistantSystem).not.toHaveBeenCalled()
  })
})
