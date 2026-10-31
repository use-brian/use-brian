/** Actual post-turn commitment consumer. [COMP:api/turn-session-state] */
import {
  bindScopeSources, boundScopeSources, DerivedScopeError, executionToolContext,
  runSessionStateDiff, type ContentBlock, type LLMProvider, type Message,
  type SessionContextAuthority, type SessionStateStore, type SessionStateDiffResult,
} from '@use-brian/core'
import { assertSourceModelInputAuthority } from '../application-platform/model-source-authority.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'

// Closed grammar only: uncertain wording retains the normal diff. Inspect the
// completed exchange, never assume that a user greeting implies a trivial answer.
function greetingOnly(user: Message, turns: readonly { content: ContentBlock[] }[], final: ContentBlock[]): boolean {
  const plain = (content: Message['content']): string | null => {
    if (typeof content === 'string') return content
    if (content.some(block => block.type !== 'text')) return null
    return content.map(block => block.type === 'text' ? block.text : '').join(' ')
  }
  const normalize = (value: string) => value.toLowerCase().replace(/[!！?？。.,，]/gu, ' ').replace(/\s+/gu, ' ').trim()
  const incoming = plain(user.content), answer = plain(final)
  if (user.role !== 'user' || incoming === null || answer === null || answer.length > 180
    || turns.some(turn => turn.content.some(block => block.type !== 'text'))) return false
  if (!/^(?:hi|hello|hey|你好|您好|こんにちは)$/u.test(normalize(incoming))) return false
  const help = "(?:how can i (?:help|assist) you(?: today)?|what can i help you with(?: today)?|what are we working on(?: today)?|what would you like to work on(?: today)?|what(?:['’]s| is) on your mind)"
  return new RegExp(`^(?:(?:hi|hello|hey)(?: there)?(?: ${help})?|${help}|你好|您好|こんにちは)$`, 'u').test(normalize(answer))
}

/** Internal host input: the incoming Message must retain its canonical binding. */
export async function runTurnSessionStateDiff(params: {
  authority: SessionContextAuthority
  provider: LLMProvider
  model: string
  store: SessionStateStore
  userMessage: Message
  assistantTurns: readonly { content: ContentBlock[] }[]
  beforePersist?: () => Promise<void>
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
  // Select only a completed substantive response; narration alongside tool_use
  // never becomes a durable commitment merely because it contained text.
  const final = [...params.assistantTurns].reverse().find(turn =>
    !turn.content.some(block => block.type === 'tool_use') &&
    turn.content.some(block => block.type === 'text' && block.text.trim().length > 0))
  if (!final) { await assertInputAuthority(); return { upserts: 0, resolves: 0, usage: null, model: null } }
  let open: Awaited<ReturnType<SessionStateStore['listOpenBySession']>> | undefined
  if (greetingOnly(params.userMessage, params.assistantTurns, final.content)) {
    if (execution.lifecycle.abortSignal.aborted) throw new AuthorityChangedError()
    await execution.security.authority.assertCurrent()
    open = await params.store.listOpenBySession(execution.lifecycle.sessionId, params.authority)
    await execution.security.authority.assertCurrent()
    if (execution.lifecycle.abortSignal.aborted) throw new AuthorityChangedError()
    if (open.length === 0) return { upserts: 0, resolves: 0, usage: null, model: null }
  }
  await assertInputAuthority()
  const text = final.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text).join('\n')
  const assistant = bindScopeSources<Message>({ role: 'assistant', content: text }, accumulator.evidence.sources ?? [])
  open ??= await params.store.listOpenBySession(execution.lifecycle.sessionId, params.authority)
  return runSessionStateDiff({
    provider: params.provider, model: params.model,
    sessionId: execution.lifecycle.sessionId, userId: execution.security.access.userId,
    assistantId: execution.assistant.id, store: params.store,
    recentTurns: [params.userMessage, assistant], openCommitments: open,
    authority: params.authority, assertInputAuthority,
    beforePersist: params.beforePersist,
  })
}
