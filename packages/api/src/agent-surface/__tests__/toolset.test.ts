/**
 * Agent capability toolset — assembly, banding, staged-write apply.
 * Component tags: [COMP:agent-surface/toolset], [COMP:agent-surface/banding],
 * [COMP:agent-surface/staged-write].
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, CONFIGURE_CAPABILITY, type ControlPlaneReader, type Tool, type ToolContext } from '@use-brian/core'

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

import { query } from '../../db/client.js'
import { bandOf, isControlPlaneWrite, TIER2_WRITE_BANDS } from '../banding.js'
import { buildAgentToolset } from '../toolset.js'
import { createAgentWriteTools } from '../write-tools.js'
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
      connectorInstanceStore: { createUserInstance: vi.fn(), createWorkspaceInstance: vi.fn(), update: vi.fn() } as never,
      connectorGrantStore: { create: vi.fn() } as never,
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

describe('[COMP:agent-surface/write-tools] addPatConnector — personal + grant', () => {
  function makeWriteDeps() {
    const createUserInstance = vi.fn(async () => ({ id: 'ci-1' }))
    const createWorkspaceInstance = vi.fn()
    const grantCreate = vi.fn(async () => ({ id: 'grant-1' }))
    const deps = {
      approvalsStore: {} as never,
      enablementStore: {} as never,
      mcpSettingsStore: {} as never,
      connectorInstanceStore: { createUserInstance, createWorkspaceInstance, update: vi.fn() } as never,
      connectorGrantStore: { create: grantCreate } as never,
      resolveApprover: vi.fn(async () => 'approver-1'),
    }
    const addPatConnector = createAgentWriteTools(deps).find((t) => t.name === 'addPatConnector')!
    return { addPatConnector, createUserInstance, createWorkspaceInstance, grantCreate }
  }

  it('mints a personal scope=user instance owned by the actor and grants it to the bound workspace — never team-native', async () => {
    const { addPatConnector, createUserInstance, createWorkspaceInstance, grantCreate } = makeWriteDeps()
    const result = await addPatConnector.execute(
      { provider: 'github', label: 'Work GitHub', token: 'ghp_aaaaaaaa' },
      ctx(),
    )
    expect(result.isError).toBeFalsy()
    // Canonical model: personal instance, NOT a team-native (scope='workspace') one.
    expect(createWorkspaceInstance).not.toHaveBeenCalled()
    expect(createUserInstance).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1', provider: 'github', label: 'Work GitHub', connected: true }),
    )
    // ...exposed to the bound workspace via a grant (the human connect-then-share shape).
    expect(grantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        actingUserId: 'owner-1',
        connectorInstanceId: 'ci-1',
        targetType: 'workspace',
        targetId: WS,
      }),
    )
    expect(String(result.data)).toContain('shared')
  })

  it('refuses OAuth providers without creating an instance or a grant', async () => {
    const { addPatConnector, createUserInstance, grantCreate } = makeWriteDeps()
    const result = await addPatConnector.execute(
      { provider: 'gmail', label: 'Mail', token: 'tok_bbbbbbbb' },
      ctx(),
    )
    expect(result.isError).toBe(true)
    expect(createUserInstance).not.toHaveBeenCalled()
    expect(grantCreate).not.toHaveBeenCalled()
  })

  it('requires a bound workspace', async () => {
    const { addPatConnector, createUserInstance, grantCreate } = makeWriteDeps()
    const result = await addPatConnector.execute(
      { provider: 'github', label: 'X', token: 'ghp_cccccccc' },
      ctx({ workspaceId: undefined }),
    )
    expect(result.isError).toBe(true)
    expect(createUserInstance).not.toHaveBeenCalled()
    expect(grantCreate).not.toHaveBeenCalled()
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

describe('[COMP:agent-surface/write-tools] workspace gate — one canonical, actionable sentence', () => {
  // The old copy was "No workspace bound to this surface." — it named neither
  // the operation nor a remedy, so the only move it left the model was to try
  // again, and this failure NEVER clears on a retry (it is a property of the
  // credential). tool-executor.md → "Failure copy".
  function gateResultFor(name: string) {
    const tools = createAgentWriteTools({
      approvalsStore: {} as never,
      enablementStore: {} as never,
      mcpSettingsStore: {} as never,
      connectorInstanceStore: {} as never,
      connectorGrantStore: {} as never,
      resolveApprover: vi.fn(async () => 'approver-1'),
    })
    return tools.find((t) => t.name === name)!
  }

  const WRITE_TOOL_NAMES = [
    'proposeSkill',
    'enableSkill',
    'disableSkill',
    'setConnectorPolicy',
    'addPatConnector',
    'configureConnectorInstance',
    'createAssistant',
    'updateAssistant',
  ]

  it.each(WRITE_TOOL_NAMES)(
    '%s names itself, diagnoses the credential, gives the admin remedy, and forbids the retry',
    async (name) => {
      const tool = gateResultFor(name)
      // Inputs are irrelevant — the gate fires before any validation the tool does.
      const result = await tool.execute({} as never, ctx({ workspaceId: undefined }))
      expect(result.isError).toBe(true)
      const text = String(result.data)
      expect(text).toContain(`\`${name}\` cannot run`)
      expect(text).toContain('not bound to a workspace')
      expect(text).toContain('re-issue or re-scope the key')
      expect(text).toContain('will fail identically')
      // The remedy must never be an instruction a keyed agent cannot follow.
      expect(text).not.toContain('No workspace bound to this surface')
    },
  )

  it('the Approve-band wrapper answers with the SAME sentence and stages nothing', async () => {
    const { toolset, approvals } = makeToolset()
    const runWorkflow = toolset.writes.get('runWorkflow')!
    const result = await runWorkflow.execute({ value: 'go' }, ctx({ workspaceId: undefined }))
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain('`runWorkflow` cannot run')
    expect(text).toContain('re-issue or re-scope the key')
    expect(text).toContain('will fail identically')
    expect(approvals.staged).toHaveLength(0)
  })
})

describe('[COMP:agent-surface/write-tools] enableSkill / disableSkill — the skill must exist', () => {
  const SKILL = '77777777-7777-4777-8777-777777777777'

  function makeSkillDeps() {
    const enable = vi.fn(async () => ({}) as never)
    const disable = vi.fn(async () => true)
    const tools = createAgentWriteTools({
      approvalsStore: {} as never,
      enablementStore: { enable, disable } as never,
      mcpSettingsStore: {} as never,
      connectorInstanceStore: {} as never,
      connectorGrantStore: {} as never,
      resolveApprover: vi.fn(async () => 'approver-1'),
    })
    return {
      enableSkill: tools.find((t) => t.name === 'enableSkill')!,
      disableSkill: tools.find((t) => t.name === 'disableSkill')!,
      enable,
      disable,
    }
  }

  /** Next `query()` answer = the workspace_skills lookup. */
  function skillRow(row: { name: string; isCurrent?: boolean } | null) {
    vi.mocked(query).mockResolvedValueOnce({
      rows: row ? [{ isCurrent: true, ...row }] : [],
    } as never)
  }

  it('enableSkill on an id no skill has FAILS instead of reporting success', async () => {
    // Before: the (skill, assistant) insert accepted any uuid, so the tool said
    // "Skill <id> enabled" for a skill that does not exist and the model told
    // the user it was on.
    const { enableSkill, enable } = makeSkillDeps()
    skillRow(null)
    const result = await enableSkill.execute({ skillId: SKILL }, ctx())
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain(SKILL)
    expect(text).toContain('listSkills')
    expect(text).toContain('Do NOT retry this exact id')
    expect(text).toContain('Nothing was enabled or disabled')
    expect(enable).not.toHaveBeenCalled()
  })

  it('enableSkill on a SUPERSEDED version says so and points at the current id', async () => {
    const { enableSkill, enable } = makeSkillDeps()
    skillRow({ name: 'Weekly digest', isCurrent: false })
    const result = await enableSkill.execute({ skillId: SKILL }, ctx())
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain('SUPERSEDED')
    expect(text).toContain('Weekly digest')
    expect(text).toContain('listSkills')
    expect(text).toContain('Do NOT retry this exact id')
    expect(enable).not.toHaveBeenCalled()
  })

  it('enableSkill on a live skill enables it and names the skill in the result', async () => {
    const { enableSkill, enable } = makeSkillDeps()
    skillRow({ name: 'Weekly digest' })
    const result = await enableSkill.execute({ skillId: SKILL }, ctx())
    expect(result.isError).toBeFalsy()
    expect(String(result.data)).toContain('Weekly digest')
    expect(enable).toHaveBeenCalledWith(SKILL, '22222222-2222-2222-2222-222222222222', 'owner-1')
  })

  it('disableSkill on an id no skill has FAILS instead of reading as an already-off no-op', async () => {
    const { disableSkill, disable } = makeSkillDeps()
    skillRow(null)
    const result = await disableSkill.execute({ skillId: SKILL }, ctx())
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('listSkills')
    expect(disable).not.toHaveBeenCalled()
  })

  it('disabling a skill that exists but was not enabled stays an informational SUCCESS (D7)', async () => {
    const { disableSkill, disable } = makeSkillDeps()
    disable.mockResolvedValueOnce(false)
    skillRow({ name: 'Weekly digest' })
    const result = await disableSkill.execute({ skillId: SKILL }, ctx())
    // The requested end state (off) holds — that is not a failure.
    expect(result.isError).toBeFalsy()
    expect(String(result.data)).toContain('already not enabled')
  })
})

describe('[COMP:agent-surface/write-tools] id misses ship the discovery pointer', () => {
  it('configureConnectorInstance names the instance id, listConnectors, and the owner-only rule', async () => {
    const instanceId = '88888888-8888-4888-8888-888888888888'
    const tools = createAgentWriteTools({
      approvalsStore: {} as never,
      enablementStore: {} as never,
      mcpSettingsStore: {} as never,
      connectorInstanceStore: { update: vi.fn(async () => null) } as never,
      connectorGrantStore: {} as never,
      resolveApprover: vi.fn(async () => 'approver-1'),
    })
    const tool = tools.find((t) => t.name === 'configureConnectorInstance')!
    const result = await tool.execute({ instanceId, label: 'x' }, ctx())
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain(instanceId)
    expect(text).toContain('listConnectors')
    expect(text).toContain('OWNS')
    expect(text).toContain('Do NOT retry this exact id')
  })

  it('updateAssistant with no fields says which fields to send instead of "Nothing to update."', async () => {
    const assistantId = '99999999-9999-4999-8999-999999999999'
    const tools = createAgentWriteTools({
      approvalsStore: {} as never,
      enablementStore: {} as never,
      mcpSettingsStore: {} as never,
      connectorInstanceStore: {} as never,
      connectorGrantStore: {} as never,
      resolveApprover: vi.fn(async () => 'approver-1'),
    })
    const result = await tools
      .find((t) => t.name === 'updateAssistant')!
      .execute({ assistantId }, ctx())
    expect(result.isError).toBe(true)
    const text = String(result.data)
    expect(text).toContain(assistantId)
    expect(text).toContain('Nothing was saved')
    expect(text).toContain('systemPrompt')
    expect(text).not.toBe('Nothing to update.')
  })
})
