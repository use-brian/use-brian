/** [COMP:api/turn-kernel] Per-turn SQL accounting phases at the real
 * PostgreSQL boundary: one fixed owned turn under recording yields a ledger
 * with a frame for every owner phase and no statement outside an owner frame.
 *
 * The lease claim, heartbeat, release and every pool statement are real. The
 * host hooks the turn owner composes (authority check, model-input admission,
 * output admission, tool, publication, follow-up, usage recorder) each issue
 * one real protected read in place of their production store, so the frame
 * attribution of each phase is observable. The provider transport is scripted.
 *
 * Runs only inside the maintained disposable fixture (BRIAN_ASSURANCE_FIXTURE).
 * Spec: docs/architecture/engine/turn-kernel.md "Per-turn SQL accounting phases".
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NOOP_TURN_LEDGER } from '@use-brian/agent-runtime/engine/turn-ledger.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import {
  createExecutionContext,
  executionToolContext
} from '@use-brian/agent-runtime/security/execution-context.js'
import { buildTool, type CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'

const fixture = Boolean(process.env.BRIAN_ASSURANCE_FIXTURE && process.env.DATABASE_URL)
const describeIf = fixture ? describe : describe.skip
if (!fixture) console.log('[turn-sql-frames integration] skipped - run inside the disposable fixture (BRIAN_ASSURANCE_FIXTURE).')

const { query, queryWithRLS, getPool, getAppPool } = await import('../../db/client.js')
const { setTurnSqlRecording, withTurnFrame, readTurnSqlLedger, turnSqlCounters } = await import('../../db/turn-sql-accounting.js')
const { openAssistantTurn, openTurnSqlScope, TURN_SQL_FRAMES, TURN_SQL_ADAPTER_FRAME } = await import('../kernel.js')
const { createTurnTiming } = await import('../../routes/turn-timings.js')

const [user, workspace, assistant, session] = Array.from({ length: 4 }, () => randomUUID())
/** One real protected read: the stand-in for each host hook's store work. */
const protectedRead = () => queryWithRLS(user, 'SELECT 1 AS present FROM workspaces WHERE id = $1', [workspace])

function scriptedProvider(): LLMProvider {
  return { name: 'fixture-sql-frames', models: [], stream() { throw new Error('Unexpected stateless dispatch') },
    createSession() {
      let calls = 0
      return { send() {
        const call = calls++
        return (async function* () {
          yield { type: 'message_start' as const, model: 'fixture' }
          if (call === 0) {
            yield { type: 'tool_use_start' as const, id: 'fixture-call', name: 'readThing' }
            yield { type: 'tool_use_delta' as const, id: 'fixture-call', input: '{}' }
            yield { type: 'tool_use_end' as const, id: 'fixture-call' }
            yield { type: 'message_end' as const, stopReason: 'tool_use' as const, usage: { inputTokens: 2, outputTokens: 1 } }
          } else {
            yield { type: 'text_delta' as const, text: 'Fictional framed answer.' }
            yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 3, outputTokens: 2 } }
          }
        })()
      } }
    } }
}

describeIf('[COMP:api/turn-kernel] per-turn SQL accounting phases', () => {
  beforeAll(async () => {
    await query("INSERT INTO users(id,auth_provider,auth_provider_id,name) VALUES($1,'test',$2,'Fictional framed user')", [user, user])
    await query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional framed workspace',$2)", [workspace, user])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace, user])
    await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional framed assistant',$2,'internal')", [assistant, workspace])
    await query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance) VALUES($1,$2,$3,'web',$5,$4,'internal')",
      [session, assistant, user, workspace, session])
  })
  afterAll(async () => {
    setTurnSqlRecording(undefined)
    await getAppPool().end(); await getPool().end()
  })

  type FrameSummary = Map<string, { statements: number; control: number; parents: Set<string | null> }>
  /** One fixed owned turn under recording, the adapter inside a different-turn
   * root frame: any statement outside an owner phase frame lands in that ledger. */
  async function fixedOwnedTurn(holdForHeartbeat: boolean) {
    setTurnSqlRecording(true)
    const outside = `outside-${randomUUID()}`
    const abort = new AbortController()
    const authority: CurrentAuthorityBoundary = { async assertCurrent() { await protectedRead() }, async execute(operation) { return operation() } }
    const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: user, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId: workspace },
      access: { workspaceId: workspace, userId: user, assistantId: assistant, assistantKind: 'standard', clearance: 'internal',
        compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [assistant] },
      writeDefaults: { compartments: [], projectIds: [] }, authority,
      lifecycle: { sessionId: session, channelType: 'web', channelId: session, abortSignal: abort.signal } })
    const context = { ...executionToolContext(execution, { appId: 'fixture' }), scopeAccumulator: new ContextScopeAccumulator(),
      admitModelInput: async () => { await protectedRead() } }
    const timing = createTurnTiming()
    try {
      const owner = await withTurnFrame({ turnId: outside, frameId: 'adapter' }, async () => {
        const turn = await openAssistantTurn({ sessionId: session, assistantId: assistant, policy: { admission: 'personal' }, abortController: abort })
        timing.attachSqlLedger(turn.sqlTurnId)
        try {
          turn.bindModelPreparation({ kind: 'execution', toolProfile: 'web', execution, assertCurrent: () => authority.assertCurrent() },
            { provider: scriptedProvider(), configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null })
          turn.registerUsageBilling({ metadata: { userId: user, assistantId: assistant, sessionId: session, workspaceId: workspace,
            modelTier: 'pro', source: 'included', providerKeySource: 'platform' }, costPolicy: 'calculate',
          recordUsage: async () => { await protectedRead() } })
          await turn.prepareMainModel({ kind: 'web', requestedModel: 'pro', plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false })
          const readThing = buildTool({ name: 'readThing', description: 'Fictional framed read', inputSchema: z.object({}).passthrough(), isReadOnly: true,
            async execute() {
              await protectedRead()
              // Optionally hold the loop open across one real heartbeat tick (20 s).
              if (holdForHeartbeat) await new Promise(resolve => setTimeout(resolve, 21_000))
              return { data: { framed: true } }
            } })
          await turn.prepareRun({ systemPrompt: 'Fictional stable prompt', messages: [{ role: 'user', content: 'Read it.' }],
            candidateTools: new Map([['readThing', readThing]]) })
          await turn.run({ budget: async () => { await protectedRead() }, loop: { ledger: NOOP_TURN_LEDGER, maxTurns: 3, context },
            sink: { kind: 'sse', admitOutput: async () => { await protectedRead() },
              afterLoop: async () => {
                await protectedRead()
                await turn.afterReplyPublication(async () => { await protectedRead() }, async () => { await protectedRead() })
              } } })
        } finally { await turn.finish('completed') }
        return turn
      })
      const ledger = owner.sqlLedger()
      const frames: FrameSummary = new Map()
      for (const statement of ledger?.statements ?? []) {
        const entry = frames.get(statement.frameId) ?? { statements: 0, control: 0, parents: new Set() }
        entry.statements++; if (statement.control) entry.control++; entry.parents.add(statement.parentFrameId)
        frames.set(statement.frameId, entry)
      }
      return { owner, ledger, frames, outside: readTurnSqlLedger(outside), timing }
    } finally { setTurnSqlRecording(undefined) }
  }

  it('records every owner phase in its own frame and nothing outside them', async () => {
    const { ledger, frames, outside, timing } = await fixedOwnedTurn(false)
    expect(outside).toBeUndefined()
    expect(ledger).toBeDefined()
    // Lease SQL is attributed at submission; this case does not wait for a heartbeat tick.
    expect([...frames.keys()].sort()).toEqual(TURN_SQL_FRAMES.filter(id => id !== 'lease_heartbeat').sort())
    expect(ledger!.overflow).toEqual({ statements: 0, fingerprints: 0, frames: 0 })
    for (const nested of ['model_input', 'output_admission', 'tool_effect']) expect([...frames.get(nested)!.parents]).toEqual(['provider_loop'])
    expect([...frames.get('follow_up')!.parents]).toEqual(['publication'])
    // Roots of this turn have no same-turn parent; the adapter root belongs to another turn.
    for (const root of ['preparation', 'provider_loop', 'publication', 'settlement'])
      expect([...frames.get(root)!.parents].every(parent => parent === null || parent === 'adapter')).toBe(true)
    expect((await query('SELECT status,turn_lease_token FROM sessions WHERE id=$1', [session])).rows[0]).toEqual({ status: 'idle', turn_lease_token: null })
    const counters = turnSqlCounters(ledger!)
    expect(counters.sql_statement_count).toBe(ledger!.statements.length)
    const snapshot = timing.snapshot()
    expect(snapshot.sql_statement_count).toBe(counters.sql_statement_count)
    expect(snapshot.sql_frame_count).toBe(frames.size)
    // Receipt material: the per-phase ledger for this fixed owned turn.
    console.info('[turn-sql-frames ledger]', JSON.stringify({
      frames: Object.fromEntries([...frames].map(([id, entry]) => [id, { statements: entry.statements, control: entry.control, parents: [...entry.parents] }])),
      fingerprints: ledger!.fingerprints.map(({ shape, count, control }) => ({ shape, count, control })),
      counters }))
  }, 60_000)

  // A callback-form `pool.query` (the system-pool `query()` the lease helpers
  // use) completes in its connection's creation context; db/client.ts records
  // it against the frame captured at submission.
  it('attributes lease SQL to admission, lease_heartbeat and settlement', async () => {
    const { frames, outside } = await fixedOwnedTurn(true)
    expect(outside).toBeUndefined()
    expect([...frames.keys()].sort()).toEqual([...TURN_SQL_FRAMES].sort())
  }, 60_000)

  // Web and channel run their whole request inside `openTurnSqlScope()` and
  // hand the scope to the owner: adapter SQL before, during and after the owner
  // lands in the `adapter` frame of the SAME ledger, so a turn's statements are
  // all attributed (turn-kernel.md "Per-turn SQL accounting phases").
  it('attributes adapter SQL around the owner to the adapter frame of one ledger', async () => {
    setTurnSqlRecording(true)
    try {
      const scope = openTurnSqlScope()
      const owner = await scope.run(async () => {
        await protectedRead()
        const turn = await openAssistantTurn({ sessionId: session, assistantId: assistant, policy: { admission: 'personal' },
          abortController: new AbortController(), sqlScope: scope })
        await protectedRead()
        await turn.finish('completed')
        await protectedRead()
        return turn
      })
      expect(owner.sqlTurnId).toBe(scope.sqlTurnId)
      const statements = owner.sqlLedger()!.statements
      expect([...new Set(statements.map(statement => statement.frameId))].sort()).toEqual([TURN_SQL_ADAPTER_FRAME, 'admission', 'settlement'].sort())
      const adapter = statements.filter(statement => statement.frameId === TURN_SQL_ADAPTER_FRAME)
      expect(adapter.length).toBeGreaterThanOrEqual(3)
      expect(adapter.every(statement => statement.parentFrameId === null)).toBe(true)
      // A scope is adopted once: a second owner mints its own ledger.
      const second = await scope.run(() => openAssistantTurn({ sessionId: session, assistantId: assistant, policy: { admission: 'personal' },
        abortController: new AbortController(), sqlScope: scope }))
      expect(second.sqlTurnId).not.toBe(scope.sqlTurnId)
      await second.finish('completed')
    } finally { setTurnSqlRecording(undefined) }
  }, 60_000)

  it('enters no frame and records nothing while recording is off', async () => {
    setTurnSqlRecording(false)
    const abort = new AbortController()
    const turn = await openAssistantTurn({ sessionId: session, assistantId: assistant, policy: { admission: 'personal' }, abortController: abort })
    await turn.finish('failed')
    expect(turn.sqlLedger()).toBeUndefined()
    setTurnSqlRecording(undefined)
  })
})
