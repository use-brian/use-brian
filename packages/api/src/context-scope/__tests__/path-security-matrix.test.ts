/**
 * Executable inventory for every non-interactive and derived-data lane that
 * participates in Team + Project context. These checks complement the SQL
 * result-set matrix: the database proof says the predicate is correct, while
 * this suite makes omission of a resolver, scope carrier, or high-water write
 * fail in the package that owns the path.
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { DepartmentReadGrant } from '@use-brian/agent-runtime/security/department-read.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { buildTool, type CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'

vi.mock('../../turn/lease.js', async original => ({ ...await original<typeof import('../../turn/lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'matrix-token', turnId: 'c'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
const { openAssistantTurn } = await import('../../turn/kernel.js')
const { currentAgentAccess } = await import('../../db/agent-access-context.js')

const workspaceRoot = new URL('../../../../../', import.meta.url)

async function source(path: string): Promise<string> {
  return readFile(new URL(path, workspaceRoot), 'utf8')
}

async function expectAnchors(path: string, anchors: readonly string[]): Promise<void> {
  const content = await source(path)
  for (const anchor of anchors) {
    expect(content, `${path} must retain ${anchor}`).toContain(anchor)
  }
}

describe('[COMP:api/context-scope-entrypoints] execution entry-point parity', () => {
  const paths: Record<string, readonly string[]> = {
    'packages/api/src/routes/chat.ts': ['resolveTurnScopeSystem', 'scopeAccumulator', 'effectiveProjectIds'],
    'packages/api/src/routes/channel-pipeline.ts': ['resolveConnectorNativeTurnScopeSystem', 'contextScope: turnScope', 'effectiveProjectIds'],
    'packages/api/src/routes/public-turn.ts': ['resolveExecutionContextSystem', 'scopeAccumulator', 'effectiveProjectIds'],
    'packages/api/src/inter-assistant/executor.ts': ['resolveTurnScopeSystem', 'contextScope: turnScope', 'scopeAccumulator'],
    'packages/api/src/brain-mcp/tools.ts': ['resolveExecutionContextSystem', 'executionToolContext', 'scopeAccumulator'],
    'packages/api/src/routes/assistant-mcp.ts': ['resolveExecutionContextSystem', 'executionToolContext', 'credentialCurrent', 'scopeAccumulator'],
    'packages/api/src/routes/session-resume-replay.ts': ['resolveTurnScopeSystem', 'scopeAccumulator', 'effectiveProjectIds'],
    'packages/api/src/boot/workflow.register.ts': ['resolveRunScope:', 'turnScope', 'contextProjectId'],
  }

  for (const [path, anchors] of Object.entries(paths)) {
    it(`keeps ${path} on one trusted TurnScope`, async () => {
      await expectAnchors(path, anchors)
    })
  }
})

describe('[COMP:api/telegram-byo-route] external guest connector scope', () => {
  it('keeps the current actor connector scope inside the shared capability request', async () => {
    const content = await source('packages/api/src/routes/channel-pipeline.ts')
    const connectorStart = content.indexOf('const createConnectorCapabilityRequest =')
    const discoveryStart = content.indexOf('const discoverContext =', connectorStart)
    expect(connectorStart).toBeGreaterThan(-1)
    expect(discoveryStart).toBeGreaterThan(connectorStart)
    const connectorBlock = content.slice(connectorStart, discoveryStart)
    const outsideConnectorBlock = content.slice(0, connectorStart) + content.slice(discoveryStart)

    expect(connectorBlock).toContain('resolveConnectorTurnScopeForChannelTurn')
    expect(connectorBlock).toContain('contextScope: turnScope')
    expect(connectorBlock).toContain("profile: 'channel'")
    expect(outsideConnectorBlock).not.toMatch(/\bturnScope\s*\./)
    expect(outsideConnectorBlock).not.toMatch(/\b(?:const|let)\s+turnScope\b/)
    expect(content).toContain('const viewerCtx = automaticContextAccess(dataTurnScope.access, dataTurnScope.activeProjectId)')
    // Forward the complete canonical access object, including departmentRead.
    // A reconstruction from legacy flat compartments can drop the v2 ceiling.
    // Since the D9 transfer the adapter supplies no scope-binding callback
    // (turn-kernel.md "Tool scope under the original invocation"): it binds its
    // canonical execution as the owner's `channel` invocation and hands the
    // roster (connector tools composed in place) to the owner, which binds it
    // with that complete access. Every connector lane (Telegram, Slack, Teams,
    // Feishu, WeChat, WhatsApp, Discord, custom bridge and the hosted channel
    // routes) enters through processChannelMessage in this file.
    expect(content).toContain("turnOwner.bindModelPreparation({ kind: 'execution', toolProfile: 'channel', execution: executionContext,")
    expect(content).toContain('turnOwner.prepareCapabilities(await createConnectorCapabilityRequest(')
    expect(content).toContain('initialMailboxCapabilities: createConnectorCapabilityRequest && isIdentified && !isolatedAudience')
    expect(content).toContain('createConnectorCapabilityRequest(await resolveConnectorUserId(), new Map())')
    expect(content).toContain('turnOwner.prepareTools(allTools)')
    expect(content).toContain('candidateTools: allTools')
    expect(content).not.toContain('bindToolsToAgentAccess(')
    const prepare = await source('packages/api/src/turn/prepare.ts')
    expect(prepare).toContain('const canonicalAccess = structuredClone(originalAccess)')
    expect(prepare).toContain("const projection = toolLane === 'channel' ? canonicalAccess")
    expect(prepare).toContain('bindToolsToAgentAccess(unbound, projection, {')
    expect(prepare).toContain('runWithAgentAccess(canonicalAccess, operation)')
    expect(prepare).toContain('new Map([...bindTools(input.candidateTools)]')
  })

  it('reaches the tool effect with the complete channel access, departmentRead included', async () => {
    const departmentRead: DepartmentReadGrant = { workspaceId: 'workspace', userId: 'guest-actor', assistantId: 'assistant',
      base: 'public', departments: { sales: 'internal' }, contextDepartment: null, binding: null, cap: null }
    const abort = new AbortController()
    const authority: CurrentAuthorityBoundary = { assertCurrent: async () => {}, execute: async operation => operation() }
    const execution = createExecutionContext({
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'guest-actor', authenticationKind: 'verified_channel' } },
      ownership: { kind: 'workspace', workspaceId: 'workspace' },
      access: { workspaceId: 'workspace', userId: 'guest-actor', assistantId: 'assistant', assistantKind: 'standard', clearance: 'internal',
        compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant'], departmentRead },
      writeDefaults: { compartments: [], projectIds: [] }, authority,
      lifecycle: { sessionId: 'session', channelType: 'telegram', channelId: 'channel', abortSignal: abort.signal },
    })
    const owner = await openAssistantTurn({ sessionId: 'session', assistantId: 'assistant', policy: { admission: 'personal' }, abortController: abort })
    try {
      owner.bindModelPreparation({ kind: 'execution', toolProfile: 'channel', execution, assertCurrent: async () => {} }, {
        provider: { name: 'fixture', models: [] } as unknown as LLMProvider,
        configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null })
      const probe = buildTool({ name: 'connectorProbe', description: 'Read the awaited scope.', inputSchema: z.object({}),
        execute: async () => { await Promise.resolve(); return { data: currentAgentAccess() } } })
      const bound = owner.prepareTools(new Map([[probe.name, probe]])).get(probe.name)!
      const result = await bound.execute({}, executionToolContext(execution, { appId: 'fixture' }))
      expect(result.data).toMatchObject({ workspaceId: 'workspace', userId: 'guest-actor', departmentRead })
    } finally { await owner.finish('failed') }
  })
})

describe('[COMP:api/session-context] immutable session context', () => {
  it('binds and locks both context axes in storage and transport', async () => {
    await expectAnchors('packages/api/src/db/sessions.ts', [
      'context_group_id',
      'context_project_id',
      'context_locked_at',
    ])
    await expectAnchors('packages/api/migrations/473_context_principal_bindings.sql', [
      'sessions_context_immutable_after_lock',
      "ERRCODE = 'P0001', MESSAGE = 'context_locked'",
    ])
  })
})

describe('[COMP:api/teamspace-context] linked Teamspace enforcement', () => {
  it('derives linked Teamspace membership and keeps legacy rosters intact', async () => {
    await expectAnchors('packages/api/migrations/475_context_surface_bindings.sql', [
      'workspace_group_id',
      'linked_teamspace_roster_is_derived',
    ])
    await expectAnchors('packages/api/src/db/teamspace-store.ts', [
      'workspaceGroupId',
      'effective_member_team_compartments',
    ])
  })
})

describe('[COMP:tasks/project-context] stable Task Project contract', () => {
  it('uses one stable Project id and carries it through supersession', async () => {
    await expectAnchors('packages/api/src/db/tasks.ts', [
      'project_ids as "projectIds"',
      'listLegacyCanonicalTasks(ctx,filters)',
      'unionScopeRequirements(old.project_ids',
    ])
    await expectAnchors('packages/api/src/db/task-reader.ts', [
      'meta.scope.projectIds.length!==0',
      'meta.scope.projectIds.length!==1||meta.scope.projectIds[0]!==filters.projectId',
    ])
    await expectAnchors('packages/core/src/tasks/tools.ts', [
      'Stable Project id for this task',
      'explicitProjectIds: input.projectId ? [input.projectId]',
      'projectGrant: context.projectIds',
    ])
    await expectAnchors('packages/api/migrations/475_context_surface_bindings.sql', [
      'context_task_project_backfill',
      'lower(btrim(substr(tag.value, 9)))',
      'ON CONFLICT (workspace_id, normalized_name) DO NOTHING',
      'tags = array_remove(t.tags, b.consumed_tag)',
    ])
  })
})

describe('[COMP:brain/ingest-context] scoped ingest inheritance', () => {
  it('stamps rule, batch, episode, and Pipeline B descendants', async () => {
    await expectAnchors('packages/core/src/ingest/engine.ts', ['project_ids', 'matchedRule.project_ids'])
    await expectAnchors('packages/core/src/ingest/pipeline-b.ts', [
      'projectIds: root.projectIds ?? []',
      'projectIds: episode.projectIds',
    ])
    await expectAnchors('packages/api/src/db/pending-ingest-batches-store.ts', [
      'project_ids',
      'projectIds',
    ])
    await expectAnchors('packages/api/src/ingest/room-ingest.ts', ['projectIds: input.projectIds ?? []'])
  })
})

describe('[COMP:workflow/context-scope] unattended context bindings', () => {
  it('carries immutable scope through workflows, goals, and schedules', async () => {
    await expectAnchors('packages/core/src/workflow/executor.ts', [
      'WORKFLOW_SCOPE_EVIDENCE_VAR',
      'scopeAccumulator.evidence',
      'turnScope',
    ])
    await expectAnchors('packages/core/src/workflow/tools.ts', [
      'contextProjectId',
      'contextProjectIds',
    ])
    await expectAnchors('packages/core/src/goals/tools.ts', ['contextGroupId', 'contextProjectId'])
    await expectAnchors('packages/core/src/scheduling/tools.ts', ['contextGroupId', 'contextProjectId'])
  })
})

describe('[COMP:brain/context-projection] cross-content projection parity', () => {
  it('projects Team and Project scope before every retrieval family expands', async () => {
    await expectAnchors('packages/api/src/db/retrieval-store.ts', [
      'buildAccessPredicate',
      'project_ids',
      'entity_instances',
      'transcript_segments',
    ])
    await expectAnchors('packages/api/src/db/knowledge-store.ts', [
      "column: 'project_ids'",
      'knowledge_entries.project_ids',
    ])
    await expectAnchors('packages/api/src/db/crm.ts', ['project_ids', 'buildAccessPredicate'])
    await expectAnchors('packages/api/src/office/service.ts', [
      'artifactWithinTurnScope',
      'scopeGrantContains(scope.projectGrant, artifact.projectIds)',
    ])
  })
})

describe('[COMP:security/scope-evidence] cross-lane high-water contract', () => {
  it('preserves evidence across reads, synthesis, updates, chunks, merges, and successors', async () => {
    const paths: Record<string, readonly string[]> = {
      'packages/agent-runtime/src/engine/tool-executor.ts': [
        'options.context.scopeAccumulator?.note(result.scopeEvidence)',
        'renderToolResultData(result.data',
      ],
      'packages/api/src/inter-assistant/executor.ts': ['noteAutomaticScopeEvidence', 'scopeAccumulator.evidence'],
      'packages/api/src/synthesis/synthesize.ts': ['new ContextScopeAccumulator', 'scopeAccumulator'],
      'packages/core/src/office/generation/pipeline.ts': ['new Set(authority.projectIds', 'entry.projectIds'],
      'packages/core/src/ingest/pipeline-b.ts': ['projectIds: episode.projectIds'],
      'packages/api/src/db/memories.ts': ['old.projectIds', 'project_ids, valid_from'],
      'packages/api/src/db/tasks.ts': ['unionScopeRequirements(old.project_ids'],
      'packages/api/src/db/knowledge-store.ts': ['knowledge_entries.project_ids || EXCLUDED.project_ids'],
      'packages/api/src/knowledge/repo-writer.ts': ['projectIds ?? entry.projectIds ?? []'],
      'packages/api/src/routes/proactive-compaction.ts': ['projectIds: params.projectIds'],
    }
    for (const [path, anchors] of Object.entries(paths)) {
      await expectAnchors(path, anchors)
    }
  })
})
