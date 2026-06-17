/**
 * Agent capability toolset — assembly, banding, staged-write apply.
 * Component tags: [COMP:agent-surface/toolset], [COMP:agent-surface/banding],
 * [COMP:agent-surface/staged-write].
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, CONFIGURE_CAPABILITY, type ControlPlaneReader, type Tool, type ToolContext } from '@sidanclaw/core'

vi.mock('../../db/client.js', () => ({
  query: vi.fn().mockResolvedValue({
    rows: [
      {
        ownerUserId: '11111111-1111-1111-1111-111111111111',
        assistantId: '22222222-2222-2222-2222-222222222222',
        clearance: 'internal',
      },
    ],
  }),
  queryWithRLS: vi.fn().mockResolvedValue({ rows: [{ id: 'a-1' }] }),
}))

import { bandOf, isControlPlaneWrite, TIER2_WRITE_BANDS } from '../banding.js'
import { buildAgentToolset } from '../toolset.js'
import { applyStagedWrite } from '../staged-write.js'
import type { PendingApproval, PendingApprovalsStore } from '../../db/pending-approvals-store.js'

const WS = '33333333-3333-3333-3333-333333333333'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'owner-1',
    assistantId: '22222222-2222-2222-2222-222222222222',
    sessionId: 's-1',
    appId: 'a-1',
    channelType: 'programmatic',
    channelId: 'key-1',
    workspaceId: WS,
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `${name} stub`,
    inputSchema: z.object({ value: z.string().optional() }),
    async execute() {
      return { data: `${name} executed` }
    },
  })
}

const READER_STUB: ControlPlaneReader = {
  listAssistants: vi.fn(async () => []),
  getAssistant: vi.fn(async () => null),
  listConnectors: vi.fn(async () => []),
  listSkills: vi.fn(async () => []),
  listChannels: vi.fn(async () => []),
  listModes: vi.fn(async () => []),
}

function makeApprovalsStore(): Pick<PendingApprovalsStore, 'createStagedWrite' | 'createStagedSkillCreation'> & {
  staged: Array<Record<string, unknown>>
} {
  const staged: Array<Record<string, unknown>> = []
  return {
    staged,
    createStagedWrite: vi.fn(async (params: Record<string, unknown>) => {
      staged.push(params)
      return { id: 'approval-1', status: 'pending' } as unknown as PendingApproval
    }) as never,
    createStagedSkillCreation: vi.fn(async () => ({ id: 'approval-skill', status: 'pending' }) as unknown as PendingApproval) as never,
  }
}

function makeToolset(allToolNames: string[] = ['createWorkflow', 'runWorkflow', 'listWorkflows', 'retractMemory']) {
  const allTools = new Map<string, Tool>(allToolNames.map((n) => [n, stubTool(n)]))
  const approvals = makeApprovalsStore()
  const toolset = buildAgentToolset({
    allTools,
    controlPlaneReader: READER_STUB,
    approvalsStore: approvals as unknown as PendingApprovalsStore,
    writeToolDeps: {
      enablementStore: { enable: vi.fn(), disable: vi.fn() } as never,
      mcpSettingsStore: { setPolicy: vi.fn() } as never,
      connectorInstanceStore: { createWorkspaceInstance: vi.fn(), update: vi.fn() } as never,
      resolveApprover: vi.fn(async () => 'approver-1'),
    },
  })
  return { toolset, approvals, allTools }
}

describe('[COMP:agent-surface/banding] band table', () => {
  it('locked conservative bands: drafts auto, consequential approve', () => {
    expect(bandOf('createWorkflow')).toBe('auto')
    expect(bandOf('updateWorkflow')).toBe('auto')
    expect(bandOf('runWorkflow')).toBe('approve')
    expect(bandOf('addPatConnector')).toBe('approve')
    expect(bandOf('createAssistant')).toBe('approve')
    expect(bandOf('enableSkill')).toBe('approve')
    expect(bandOf('disableSkill')).toBe('auto')
    expect(bandOf('setConnectorPolicy')).toBe('auto')
    expect(bandOf('proposeSkill')).toBe('auto')
  })

  it('reads are not control-plane writes', () => {
    expect(isControlPlaneWrite('listAssistants')).toBe(false)
    expect(isControlPlaneWrite('listWorkflows')).toBe(false)
    expect(isControlPlaneWrite('searchBrain')).toBe(false)
  })

  it('every banded name is auto or approve — no third state sneaks in', () => {
    for (const band of Object.values(TIER2_WRITE_BANDS)) {
      expect(['auto', 'approve']).toContain(band)
    }
  })
})

describe('[COMP:agent-surface/toolset] buildAgentToolset', () => {
  it('bridges boot instances by name and adds the control-plane reads', () => {
    const { toolset } = makeToolset()
    expect(toolset.reads.has('listWorkflows')).toBe(true)
    expect(toolset.reads.has('listAssistants')).toBe(true)
    expect(toolset.reads.has('listConnectors')).toBe(true)
    // Writes partition: bridge writes land in writes, not reads.
    expect(toolset.reads.has('createWorkflow')).toBe(false)
    expect(toolset.writes.has('createWorkflow')).toBe(true)
  })

  it('missing bridge names degrade gracefully (no phantom tools)', () => {
    const { toolset } = makeToolset(['listWorkflows'])
    expect(toolset.writes.has('createWorkflow')).toBe(false)
    expect(toolset.reads.has('listWorkflows')).toBe(true)
  })

  it('auto-band writes pass through unwrapped — execute runs the real tool', async () => {
    const { toolset, approvals } = makeToolset()
    const createWorkflow = toolset.writes.get('createWorkflow')!
    const result = await createWorkflow.execute({ value: 'x' }, ctx())
    expect(result.data).toBe('createWorkflow executed')
    expect(approvals.staged).toHaveLength(0)
  })

  it('approve-band writes stage a staged_write approval instead of executing', async () => {
    const { toolset, approvals } = makeToolset()
    const runWorkflow = toolset.writes.get('runWorkflow')!
    const result = await runWorkflow.execute({ value: 'go' }, ctx())
    expect(String(result.data)).toContain('Staged for human approval')
    expect(approvals.staged).toHaveLength(1)
    expect(approvals.staged[0]).toMatchObject({
      workspaceId: WS,
      toolName: 'runWorkflow',
      approverUserId: 'approver-1',
      surface: 'brain_mcp',
      credentialId: 'key-1',
    })
  })

  it('the approve-band wrapper advertises the approval flow in its description and keeps the configure tag', () => {
    const { toolset } = makeToolset()
    const runWorkflow = toolset.writes.get('runWorkflow')!
    expect(runWorkflow.description).toContain('human approval')
    expect(runWorkflow.requiresCapability).toBe(CONFIGURE_CAPABILITY)
  })

  it('rawWrites keeps the UNWRAPPED instances for the staged-write executor', async () => {
    const { toolset, approvals } = makeToolset()
    const raw = toolset.rawWrites.get('runWorkflow')!
    const result = await raw.execute({ value: 'go' }, ctx())
    expect(result.data).toBe('runWorkflow executed')
    expect(approvals.staged).toHaveLength(0)
  })

  it('surface attribution follows the context channelType', async () => {
    const { toolset, approvals } = makeToolset()
    const runWorkflow = toolset.writes.get('runWorkflow')!
    await runWorkflow.execute({ value: 'go' }, ctx({ channelType: 'assistant_mcp', channelId: 'api-key-9' }))
    expect(approvals.staged[0]).toMatchObject({ surface: 'assistant_mcp', credentialId: 'api-key-9' })
  })

  it('build-new write tools are configure-tagged', () => {
    const { toolset } = makeToolset()
    for (const name of ['proposeSkill', 'enableSkill', 'setConnectorPolicy', 'createAssistant']) {
      const tool = toolset.writes.get(name)
      expect(tool, name).toBeDefined()
      expect(tool!.requiresCapability, name).toBe(CONFIGURE_CAPABILITY)
    }
  })
})

describe('[COMP:agent-surface/staged-write] applyStagedWrite', () => {
  function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
    return {
      id: 'approval-1',
      workspaceId: WS,
      toolName: 'runWorkflow',
      arguments: { value: 'go' },
      approvalPayload: { surface: 'brain_mcp', credentialId: 'key-1' },
      originatingAssistantId: null,
      kind: 'staged_write',
      status: 'pending',
      approverUserId: 'approver-1',
      ...overrides,
    } as unknown as PendingApproval
  }

  it('executes the raw tool with the approver as acting user', async () => {
    let seenCtx: ToolContext | undefined
    const tool = buildTool({
      name: 'runWorkflow',
      description: 'capture',
      inputSchema: z.object({ value: z.string() }),
      async execute(_input, c) {
        seenCtx = c
        return { data: 'applied' }
      },
    })
    const outcome = await applyStagedWrite({ rawWrites: new Map([['runWorkflow', tool]]) }, approval(), 'approver-1')
    expect(outcome).toEqual({ ok: true, resultText: 'applied' })
    expect(seenCtx!.userId).toBe('approver-1')
    expect(seenCtx!.workspaceId).toBe(WS)
    // Provenance carries the staging surface + credential.
    expect(seenCtx!.channelType).toBe('brain_mcp')
    expect(seenCtx!.channelId).toBe('key-1')
  })

  it('fails closed on an unknown tool name', async () => {
    const outcome = await applyStagedWrite({ rawWrites: new Map() }, approval(), 'approver-1')
    expect(outcome.ok).toBe(false)
  })

  it('fails closed when the frozen arguments no longer validate', async () => {
    const tool = buildTool({
      name: 'runWorkflow',
      description: 'strict',
      inputSchema: z.object({ value: z.number() }),
      async execute() {
        return { data: 'never' }
      },
    })
    const outcome = await applyStagedWrite(
      { rawWrites: new Map([['runWorkflow', tool]]) },
      approval({ arguments: { value: 'not-a-number' } } as never),
      'approver-1',
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('validate')
  })

  it('propagates a tool error as a failed outcome (row stays pending at the route)', async () => {
    const tool = buildTool({
      name: 'runWorkflow',
      description: 'boom',
      inputSchema: z.object({ value: z.string() }),
      async execute() {
        return { data: 'workflow is disabled', isError: true }
      },
    })
    const outcome = await applyStagedWrite({ rawWrites: new Map([['runWorkflow', tool]]) }, approval(), 'approver-1')
    expect(outcome.ok).toBe(false)
  })
})
