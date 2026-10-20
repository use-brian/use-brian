/** Actual post-turn commitment consumer. [COMP:api/application-persistence] */
import {
  bindScopeSources, boundScopeSources, DerivedScopeError, executionToolContext,
  runSessionStateDiff, type ContentBlock, type LLMProvider, type Message,
  type SessionContextAuthority, type SessionStateStore, type SessionStateDiffResult,
} from '@use-brian/core'
import { assertSourceModelInputAuthority } from '../application-platform/model-source-authority.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'

/** Internal host input: the incoming Message must retain its canonical binding. */
export async function runTurnSessionStateDiff(params: {
  authority: SessionContextAuthority
  provider: LLMProvider
  model: string
  store: SessionStateStore
  userMessage: Message
  assistantTurns: readonly { content: ContentBlock[] }[]
}): Promise<SessionStateDiffResult> {
  const { execution, accumulator } = params.authority
  const sources = boundScopeSources(params.userMessage)
  if (!sources.length) throw new DerivedScopeError('scope_evidence_missing')
  accumulator.note({ sources })
  const context = { ...executionToolContext(execution, { appId: 'Use Brian' }), scopeAccumulator: accumulator }
  const assertInputAuthority = async () => {
    if (execution.lifecycle.abortSignal.aborted) throw new AuthorityChangedError()
    await execution.security.authority.assertCurrent()
    await assertSourceModelInputAuthority(context)
    if (execution.lifecycle.abortSignal.aborted) throw new AuthorityChangedError()
  }
  await assertInputAuthority()
  // Select only a completed substantive response; narration alongside tool_use
  // never becomes a durable commitment merely because it contained text.
  const final = [...params.assistantTurns].reverse().find(turn =>
    !turn.content.some(block => block.type === 'tool_use') &&
    turn.content.some(block => block.type === 'text' && block.text.trim().length > 0))
  if (!final) return { upserts: 0, resolves: 0, usage: null, model: null }
  const text = final.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text).join('\n')
  const assistant = bindScopeSources<Message>({ role: 'assistant', content: text }, accumulator.evidence.sources ?? [])
  const open = await params.store.listOpenBySession(execution.lifecycle.sessionId, params.authority)
  return runSessionStateDiff({
    provider: params.provider, model: params.model,
    sessionId: execution.lifecycle.sessionId, userId: execution.security.access.userId,
    assistantId: execution.assistant.id, store: params.store,
    recentTurns: [params.userMessage, assistant], openCommitments: open,
    authority: params.authority, assertInputAuthority,
  })
}
