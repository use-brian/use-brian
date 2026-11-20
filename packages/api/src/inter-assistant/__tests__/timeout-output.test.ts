/**
 * Unit tests for the cross-assistant (callee) executor.
 * Component tag: [COMP:api/inter-assistant-executor].
 *
 * Mocks the DB lookups + billing resolver and stubs `queryLoop` with a
 * controllable async generator (the pure core helpers — prompt /
 * memory-context / tool-filter builders — run for real). Verifies the
 * callee/owner not-found throws, the assistant_turn-based final-text
 * assembly (leak-suppressed / retried turns contribute nothing), the
 * typed empty_response failure, the direct-execution framing block,
 * error-event propagation, and that free mode injects getMemory into
 * the callee's tool set.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// These unit fixtures replace database/scope ports and have no canonical policy
// metadata. Keep their fixture assistant and inject only metadata construction;
// actual current assistants/epochs are enforced by the complete real SQL matrix.
vi.mock('../../context-scope/execution-context.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../context-scope/execution-context.js')>()
  return { ...actual,resolveExecutionContextSystem: (input: Parameters<typeof actual.resolveExecutionContextSystem>[0],
    deps: Parameters<typeof actual.resolveExecutionContextSystem>[1] = {}) => actual.resolveExecutionContextSystem(input,{
      ...deps,pinPolicyEpoch: async () => ({isCurrent: async () => true, matches: () => true}),resolveAssistant: async () => input.assistant,
    }) }
})
// Legacy fake rows have no database authority facts. This fixture boundary
// retains ambient caller leases; owner.test.ts exercises the canonical session lease.
vi.mock('../../context-scope/authority-lease.js', async original => {
  const actual = await original<typeof import('../../context-scope/authority-lease.js')>()
  return { ...actual, createSessionAuthorityLease: () => ({
    assertCurrent: async () => {}, execute: async <T>(operation: () => Promise<T>) => operation(),
    markOperationMayHaveExecuted() {},
  }) }
})
import { z } from 'zod'

const mockQueryLoop = vi.fn()
const mockRunPreflight = vi.fn()
const mockLoadDecisionPlaybookContext = vi.fn()

// Override queryLoop + runPreflight; everything else (buildPreflightPrompt,
// prompt/memory-context builders, MODEL_MAP) runs for real so the system-prompt
// injection + model resolution are exercised end to end.
vi.mock('@use-brian/core/engine/query-loop-defaults.js', async (io) => ({
  ...(await io<typeof import('@use-brian/core/engine/query-loop-defaults.js')>()),
  queryLoop: async function* (options: import('@use-brian/agent-runtime/engine/query-loop.js').QueryLoopOptions) {
    for await (const event of mockQueryLoop(options)) {
      if (event.type === 'turn_complete' && event.totalUsage) {
        options.observeUsage?.({model:event.response.model,totalUsage:event.totalUsage})
      }
      if (options.dispatchOutput) await options.dispatchOutput(options.context, event)
      else yield event
    }
  },
}))
vi.mock('@use-brian/core/workers/preflight.js', async (io) => ({
  ...(await io<typeof import('@use-brian/core/workers/preflight.js')>()),
  runPreflight: (...a: unknown[]) => mockRunPreflight(...a),
}))
vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(),
  findOrCreateUser: vi.fn(),
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  resolveAssistantAccess: vi.fn(),
}))
vi.mock('../../decision-learning/playbook-context.js', () => ({
  loadDecisionPlaybookContext: (...args: unknown[]) => mockLoadDecisionPlaybookContext(...args),
}))
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  addSessionMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
  getSessionMessages: vi.fn().mockResolvedValue([]),
  findSessionById: vi.fn().mockResolvedValue(null),
  readSessionById: vi.fn().mockResolvedValue(null),
  findSessionByChannel: vi.fn().mockResolvedValue(null),
  toStampedMessages: vi.fn((m: unknown) => m),
  // Delivery-conversation lookup for the session-state bridge. Empty by
  // default so every consult that carries a deliverTarget stays block-free
  // unless a test seeds it.
  listSessionsByChannelForWorkspaceSystem: vi.fn().mockResolvedValue([]),
  // Turn-kernel lease (every callee turn holds one).
  reclaimStaleTurn: vi.fn().mockResolvedValue(false),
  claimTurnLease: vi.fn().mockResolvedValue('lease-token'),
  claimTurnLeaseOutcome:vi.fn().mockResolvedValue({token:'lease-token',turnId:null}),
  touchTurnLease: vi.fn().mockResolvedValue({ held: true, cancelRequested: false }),
  releaseTurnLease: vi.fn().mockResolvedValue(true),
  releaseTurnOutcome:vi.fn(async(_id:string,reason:string)=>({turnId:null,reason})),
  TURN_HEARTBEAT_INTERVAL_MS: 20_000,
}))
vi.mock('../../billing-party.js', () => ({
  billingPartyForAssistant: vi.fn(),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getConnectorUserId: vi.fn().mockResolvedValue('owner-1'),
  getWorkspacePlan: vi.fn().mockResolvedValue('pro'),
  getWorkspaceRoleSystem: vi.fn().mockResolvedValue('member'),
  // The retired injector gated the owner-personal base load on this; `true`
  // (solo workspace) preserves the pre-gate load behavior these tests expect.
  isSoloWorkspaceSystem: vi.fn().mockResolvedValue(true),
  // Read-ceiling resolver for the brain retrieval actor. Returned shape mirrors
  // the real `min(member, assistant)` ceiling; the callee threads it onto the
  // query-loop ToolContext.
  resolveOperationCeilingsSystem: vi
    .fn()
    .mockResolvedValue({ clearance: 'confidential', compartments: null, mutationCompartments: null }),
}))
// The callee's capability surface (`turn/capabilities.ts` → `mcp/surface.ts`):
// `composeCallee` records the callee's parameter block, `surfaces` the surface id.
const surfaceMocks = vi.hoisted(() => ({
  surfaces: [] as string[],
  composeCallee: vi.fn<(params: SurfaceCapabilityOptions) => Promise<SurfaceCapabilities>>(async () => ({
    enrichConfirmation: async (_t: string, i: Record<string, unknown>) => i,
    unavailable: [],
    searchableSources: [],
    restrictedSearchToolNames: [],
  })),
}))
vi.mock('../../mcp/surface.js', () => ({
  composeSurfaceCapabilities: (surface: string, params: SurfaceCapabilityOptions) => {
    surfaceMocks.surfaces.push(surface)
    return surfaceMocks.composeCallee(params)
  },
}))
vi.mock('../../routes/proactive-compaction.js', () => ({
  runProactiveCompaction: vi.fn().mockResolvedValue({ messages: [], compacted: false, episodes: [] }),
}))
// Doc-tool injector — mocked so we can assert it fires (or not) for a callee.
// The host extra-tool injector (injectExtraTools) is passed per-test as a vi.fn
// since it is a generic seam, not a module import. The real prompt builder (the
// doc soul) runs for real, so the system-prompt assertions exercise the wiring.
vi.mock('../../doc/inject.js', () => ({
  injectDocTools: vi.fn().mockResolvedValue(undefined),
}))

import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { createCalleeExecutor } from '../../inter-assistant/executor.js'
import * as callerEvidence from '../../context-scope/caller-evidence.js'
import * as externalAncestry from '../../application-platform/external-source-ancestry.js'
import * as fieldEvidence from '../../application-platform/field-evidence.js'
// Real (unmocked) core factories — the query-loop and preflight mocks above
// spread the actual modules, so everything but queryLoop/runPreflight resolves for real.
// Used by the goal-path browser-surface describes at the bottom of this file.
import {
  createInMemoryBrowserSkillStore,
  createInMemoryBrowserSkillGrantStore,
  createInMemoryBlockApprovals,
} from '@use-brian/core/sandbox/browser-skills.js'
import { createBuFallbackTool } from '@use-brian/core/sandbox/bu-fallback.js'
import { createCloudBrowserProvider } from '@use-brian/core/sandbox/cloud-browser-provider.js'
import { extractEffectContract } from '@use-brian/core/sandbox/effect-contract.js'
import { createLocalBrowserProvider } from '@use-brian/core/sandbox/local-browser-provider.js'
import {
  createSandboxOrchestrator,
  createInMemorySandboxTaskStore,
} from '@use-brian/core/sandbox/orchestrator.js'
import {
  createInMemoryBrowserProfileStore,
  createInMemorySessionVault,
} from '@use-brian/core/sandbox/profiles.js'
import { StubSandboxProvider } from '@use-brian/core/sandbox/providers/stub.js'
import { RESULT_PATH } from '@use-brian/core/sandbox/runner-shim.js'
import { createSkillRunnerTools } from '@use-brian/core/sandbox/skill-runner.js'
import { createComputerTools } from '@use-brian/core/sandbox/tools.js'
import { AuthoritySourceSchema } from '@use-brian/agent-runtime/security/authority-source.js'
import { buildTool } from '@use-brian/agent-runtime/tools/types.js'
import {
  findAssistantById,
  findOrCreateUser,
  findUserByEmail,
  findUserById,
  resolveAssistantAccess,
} from '../../db/users.js'
import {
  findOrCreateSession,
  readSessionById,
  addSessionMessage,
  listSessionsByChannelForWorkspaceSystem,
} from '../../db/sessions.js'
import { billingPartyForAssistant } from '../../billing-party.js'
import { resolveOperationCeilingsSystem, getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { runProactiveCompaction } from '../../routes/proactive-compaction.js'
import { injectDocTools } from '../../doc/inject.js'
import type { SurfaceCapabilities, SurfaceCapabilityOptions } from '../../mcp/surface.js'
const composeCallee = surfaceMocks.composeCallee
import {
  engineCostModel,
  flatEngineCostUsd,
} from '@use-brian/core/billing/engine-provider-rates.js'
import { encodeExternalCostMeta } from '@use-brian/core/billing/external-cost.js'
import { flatSearchCostUsd } from '@use-brian/core/billing/search-provider-rates.js'

const mockInjectDoc = vi.mocked(injectDocTools)
const mockInjectMcp = vi.mocked(composeCallee)

const mockFindAssistant = vi.mocked(findAssistantById)
const mockFindUser = vi.mocked(findUserById)
const mockFindOrCreateUser = vi.mocked(findOrCreateUser)
const mockFindUserByEmail = vi.mocked(findUserByEmail)
const mockResolveAssistantAccess = vi.mocked(resolveAssistantAccess)
const mockResolveReadCeilings = vi.mocked(resolveOperationCeilingsSystem)
const mockSession = vi.mocked(findOrCreateSession)
const mockAddMessage = vi.mocked(addSessionMessage)
const mockListConversationSessions = vi.mocked(listSessionsByChannelForWorkspaceSystem)
const mockBilling = vi.mocked(billingPartyForAssistant)
const mockRunProactiveCompaction = vi.mocked(runProactiveCompaction)

const calleeAssistant = {
  id: 'callee-1',
  ownerUserId: 'owner-1',
  workspaceId: null,
  kind: 'standard' as const,
  clearance: 'internal',
  compartments: null,
  defaultCompartments: [],
  name: 'Callee Bot',
}
const callerAssistant = { id: 'caller-1', name: 'Caller Bot' }

function memoryStore() {
  return {
    getSoul: vi.fn().mockResolvedValue(null),
    getIdentity: vi.fn().mockResolvedValue([]),
    getIndexRanked: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
    getWorkspaceIdentity: vi.fn().mockResolvedValue([]),
    getWorkspaceIndex: vi.fn().mockResolvedValue([]),
  }
}

function executor() {
  return createCalleeExecutor({
    provider: {} as never,
    tools: new Map(),
    memoryStore: memoryStore() as never,
    capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
  })
}

/**
 * Same, but with the two stores that gate MCP injection — without both,
 * `injectMcpTools` never runs, so anything derived from its result (the
 * unavailable-capabilities block) is silently absent.
 */
function executorWithMcp() {
  return createCalleeExecutor({
    provider: {} as never,
    tools: new Map(),
    memoryStore: memoryStore() as never,
    capabilityStore: { listActive: vi.fn().mockResolvedValue([]) } as never,
    connectorStore: {} as never,
    mcpSettingsStore: {} as never,
  })
}

const baseParams = {
  callerUserId:'owner-1',
  callerAssistantId: 'caller-1',
  calleeAssistantId: 'callee-1',
  mode: null,
  question: 'what is the status?',
  callerSessionId: 'caller-sess-1',
}

/** queryLoop stub yielding the given events as an async generator. */
function yields(events: Array<Record<string, unknown>>) {
  mockQueryLoop.mockImplementationOnce(async function* () {
    for (const e of events) yield e
  })
}

/**
 * Minimal healthy stream: one finalised text turn + terminal turn_complete.
 * The consult text is assembled from `assistant_turn` events, and an all-empty
 * consult now THROWS `empty_response` — so tests that only assert on wiring
 * (tool injection, actor scoping, analytics) still need a turn with text.
 */
function yieldsText(text = 'ok') {
  yields([
    { type: 'assistant_turn', response: { content: [{ type: 'text', text }] }, toolResults: [] },
    { type: 'turn_complete', response: { content: [{ type: 'text', text }] } },
  ])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getWorkspaceRoleSystem).mockResolvedValue('member')
  mockFindAssistant.mockImplementation(async (id: string) =>
    (id === 'callee-1' ? calleeAssistant : id === 'caller-1' ? callerAssistant : null) as never,
  )
  mockFindUser.mockResolvedValue({ id: 'owner-1', timezone: 'UTC' } as never)
  mockFindUserByEmail.mockResolvedValue(null)
  mockResolveAssistantAccess.mockResolvedValue({ role: 'member' } as never)
  mockLoadDecisionPlaybookContext.mockResolvedValue({
    playbookRules: [],
    appliedRuleIds: [],
    decisionApplicationId: null,
    readFailed: false,
  })
  mockFindOrCreateUser.mockResolvedValue({
    user: {
      id: 'client-shadow-1',
      authProvider: 'channel',
      authProviderId: 'api:00000000-0000-4000-8000-000000000010:client-17',
      name: 'api:client-17',
    },
    isNew: false,
  } as never)
  mockResolveReadCeilings.mockImplementation(async (_userId, _workspaceId, clearance, compartments) => ({
    clearance,
    compartments: compartments === undefined ? [] : compartments,
    mutationCompartments: compartments === undefined ? [] : compartments,
  }))
  mockBilling.mockResolvedValue('owner-1')
  mockSession.mockImplementation(async params => ({ id:'sess-1',visibility:'personal',mode:null,
    anchorKind:'none',anchorRef:null,appOrigin:null,contextLockedAt:null,effectiveClearance:null,
    contextCompartments:[], ...params }) as never)
  vi.mocked(readSessionById).mockImplementation(async () => ({ id:'sess-1',visibility:'personal',mode:null,
    anchorKind:'none',anchorRef:null,appOrigin:null,contextLockedAt:null,effectiveClearance:null,
    contextCompartments:[],...mockSession.mock.lastCall?.[0] }) as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})


describe('[COMP:api/inter-assistant-executor] finalized timeout diagnostics', () => {
  const cases = [
    { name:'tool-call narration', events:[
      {type:'text_delta',text:'Synthetic private tool narration'},
      {type:'assistant_turn',response:{content:[{type:'text',text:'Synthetic private tool narration'},{type:'tool_use',id:'synthetic-call',name:'lookup',input:{}}]},toolResults:[]},
    ], expected:undefined },
    { name:'suppressed turn', events:[
      {type:'text_delta',text:'Synthetic suppressed text'},
      {type:'assistant_turn',response:{content:[]},toolResults:[]},
    ], expected:undefined },
    { name:'unfinished delta', events:[{type:'text_delta',text:'Synthetic unfinished text'}], expected:undefined },
    { name:'unchanged finalized positive', events:[
      {type:'text_delta',text:'Verified synthetic finding.'},
      {type:'assistant_turn',response:{content:[{type:'text',text:'Verified synthetic finding.'}]},toolResults:[]},
    ], expected:'Verified synthetic finding.' },
    { name:'finalized text before tool narration', events:[
      {type:'assistant_turn',response:{content:[{type:'text',text:'Verified synthetic finding.'}]},toolResults:[]},
      {type:'text_delta',text:'Synthetic later tool narration'},
      {type:'assistant_turn',response:{content:[{type:'text',text:'Synthetic later tool narration'},{type:'tool_use',id:'later-call',name:'lookup',input:{}}]},toolResults:[]},
    ], expected:'Verified synthetic finding.' },
    { name:'retracted finalized draft', events:[
      {type:'assistant_turn',response:{content:[{type:'text',text:'Synthetic retracted finding'}]},toolResults:[]},
      {type:'grounding_nudge',text:'Review the unsupported result'},
    ], expected:undefined },
    { name:'finalized delivery scaffolding', events:[
      {type:'text_delta',text:'Message body:\nVerified synthetic finding.'},
      {type:'assistant_turn',response:{content:[{type:'text',text:'Message body:\nVerified synthetic finding.'}]},toolResults:[]},
    ], expected:'Verified synthetic finding.' },
  ]
  for (const failure of ['stall','deadline'] as const) {
    it.each(cases)(`${failure} retains only eligible output: $name`, async ({events,expected}) => {
      if (failure==='deadline') vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
      try {
        let enter!:()=>void
        const entered=new Promise<void>(resolve=>{enter=resolve})
        mockQueryLoop.mockImplementationOnce(async function* (options:{context:{abortSignal:AbortSignal}}) {
          for (const event of events) yield event
          enter()
          if(failure==='stall') throw Object.assign(new Error('Synthetic provider stall'),{code:'stalled'})
          await new Promise<void>((_resolve,reject)=>options.context.abortSignal.addEventListener('abort',()=>reject(new Error('Synthetic provider abort')),{once:true}))
        })
        const pending=executor()({...baseParams,...(failure==='deadline'?{depth:{timeoutMs:1000}}:{})})
          .then(value=>({value,error:undefined}),error=>({value:undefined,error}))
        await Promise.race([entered,pending.then(result=>{if(result.error)throw result.error})])
        if(failure==='deadline') await vi.advanceTimersByTimeAsync(1000)
        const {error}=await pending
        expect(error?.reason).toBe('timeout')
        expect(error?.partialOutput===expected).toBe(true)
      } finally { if(failure==='deadline') vi.useRealTimers() }
    })
  }
})
