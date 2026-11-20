/** Test-local construction adapter. Every invocation drives the SAME production
 * claim, verified model preparation, run and settlement path as the adapters.
 * It does not export an old production preassembled-loop or no-session escape. */
import { createExecutionContext, type ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { CurrentAuthorityBoundary } from '@use-brian/agent-runtime/tools/types.js'
import { openAssistantTurn as openProductionTurn, type AssistantTurn, type AssistantTurnLoopInput } from '../../kernel.js'
import { tierForModel } from '../../../model-resolution.js'

export type FixtureTurnInput = AssistantTurnLoopInput & { prepareBackground?: boolean }
export type FixtureTurnOwner = Omit<AssistantTurn, 'run'> & { run(input: FixtureTurnInput): ReturnType<AssistantTurn['run']> }

/** A unit fixture with no domain execution gets a test-owned system execution
 * over its own identity fields and admission callback. Every production lane
 * binds a canonical execution; the owner has no flat-context invocation. A
 * partial test double (`{ security: { authority } }`) keeps its authority. */
function fixtureExecution(context: FixtureTurnInput['loop']['context'], authority: CurrentAuthorityBoundary): ExecutionContext {
  const workspaceId = context.workspaceId ?? 'fixture-workspace'
  return createExecutionContext({ identity: { kind: 'system', purpose: 'maintenance', jobId: 'owned-turn-fixture' },
    ownership: workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'personal', ownerUserId: context.userId },
    access: { workspaceId, userId: context.userId, assistantId: context.assistantId, assistantKind: context.assistantKind ?? 'standard',
      clearance: context.clearance ?? 'internal', compartments: context.compartments ?? null,
      mutationCompartments: context.mutationCompartments ?? context.compartments ?? null, projectIds: context.projectIds ?? null,
      visibilityAssistantIds: context.visibilityAssistantIds ?? [context.assistantId] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { abortSignal: context.abortSignal ?? new AbortController().signal, sessionId: context.sessionId,
      channelType: context.channelType ?? 'fixture', channelId: context.channelId ?? context.sessionId } })
}

async function prepare(owner: AssistantTurn, input: FixtureTurnInput) {
  const context = input.loop.context
  // Unit fixtures with no domain context get only test-owned identity fields.
  // Their content/admission callbacks stay intact.
  context.sessionId ??= input.sessionId
  context.assistantId ??= 'fixture-assistant'
  context.userId ??= 'fixture-user'
  context.workspaceId ??= context.executionContext?.security?.access?.workspaceId ?? 'fixture-workspace'
  const authority: CurrentAuthorityBoundary = context.executionContext?.security?.authority ?? context.authority ?? {
    async assertCurrent() {}, async execute(operation) { return operation() },
  }
  const current = async () => { context.abortSignal?.throwIfAborted(); await authority.assertCurrent() }
  const real = context.executionContext?.security?.access && context.executionContext.lifecycle
  if (!real) { context.executionContext = fixtureExecution(context, authority); context.authority = authority }
  owner.bindModelPreparation({ kind: 'execution', toolProfile: 'web', execution: context.executionContext!, assertCurrent: current }, {
      provider: input.model.provider, configuredProviders: input.model.configuredProviders,
      resolveWorkspaceCustomLlm: input.model.customLlm ? async () => input.model.customLlm : null,
      resolveLegacyByoKey: null, buildLegacyByoProvider: null,
    })
  if (input.prepareBackground) await owner.prepareBackgroundModel({ configuredDefault: true })
  await owner.prepareMainModel({ kind: 'web', requestedModel: input.model.customLlm?.selector ?? tierForModel(input.model.model),
    plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false })
}

export async function openAssistantTurn(input: Parameters<typeof openProductionTurn>[0] & Partial<FixtureTurnInput>): Promise<FixtureTurnOwner> {
  const owner = await openProductionTurn(input)
  let prepared = false, runPrepared = false
  const run = owner.run.bind(owner)
  const fixture = owner as unknown as FixtureTurnOwner
  fixture.run = async options => {
    if (!prepared) { await prepare(owner, options); prepared = true }
    const { model: _model, sessionId: _session, policy: _policy, abortController: _abort, prepareBackground: _background, loop, ...rest } = options
    // The fixture submits its assembled values once through the production
    // owner's prepareRun; run then consumes only the owner's private copy.
    const { systemPrompt, runtimeSystemContext, messages, tools, maxTokens: _maxTokens, inputTokenLimit: _inputTokenLimit, ...owned } = loop
    if (!runPrepared) {
      runPrepared = true
      await owner.prepareRun({ systemPrompt, messages, candidateTools: tools,
        trustedContributions: runtimeSystemContext ? [{ name: 'runtime', content: runtimeSystemContext }] : [] })
    }
    return run({ ...rest, loop: owned })
  }
  return fixture
}

export async function runAssistantTurn(input: FixtureTurnInput) {
  const owner = await openAssistantTurn(input)
  try { return await owner.run(input) } finally { await owner.finish() }
}

/** Database-bound fixtures formerly used a lease-free synthetic session. Seed
 * only the exact owned fixture row, then exercise real claim and exact release.
 * This is unavailable outside the maintained disposable fixture envelope. */
export async function runPersistedFixtureTurn(input: FixtureTurnInput) {
  const { assertLocalFixture } = await import(new URL('../../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
  await assertLocalFixture()
  const { getPool } = await import('../../../db/client.js')
  const context = input.loop.context, execution = context.executionContext
  const assistantId = execution?.assistant.id ?? context.assistantId
  const userId = execution?.security.access.userId ?? context.userId
  const workspaceId = execution ? execution.security.access.workspaceId : context.workspaceId
  if (!assistantId || !userId) throw new Error('The owned turn fixture requires its original identity')
  const pool = getPool()
  let row = (await pool.query('SELECT assistant_id,user_id,workspace_id,visibility FROM sessions WHERE id=$1', [input.sessionId])).rows[0]
  if (!row) {
    await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,visibility)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'owned-turn-fixture',$1::text,'owner') ON CONFLICT(id) DO NOTHING`,
      [input.sessionId, assistantId, userId, workspaceId || null])
    row = (await pool.query('SELECT assistant_id,user_id,workspace_id,visibility FROM sessions WHERE id=$1', [input.sessionId])).rows[0]
  }
  if (!row || row.assistant_id !== assistantId || (row.user_id !== userId && row.visibility !== 'workspace') || row.workspace_id !== (workspaceId || null)) {
    throw new Error('The owned turn fixture session identity changed')
  }
  return runAssistantTurn(input)
}
