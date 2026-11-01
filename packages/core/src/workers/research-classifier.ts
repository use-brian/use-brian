import {bindScopeSources,boundScopeSources} from '../security/source-evidence.js'
import {isTrivialChatMessage} from '../classification/trivial-chat.js'
import {DerivedScopeError} from '../security/derived-scope.js'
import {assertInputAuthority,isInputAuthorityError} from '../providers/input-authority.js'
import type {SessionContextAuthority} from '../memory/session-state-types.js'
/**
 * Pre-flight classifier for adaptive research-mode entry.
 *
 * An isolated cheap assessment receives the request and admitted dialogue,
 * decides whether fresh multi-source evidence is needed, and chooses effort.
 * The chat route promotes research turns to the stronger model and read-only
 * parallel workers. The caller owns quota and credit admission.
 *
 * [COMP:workers/research-classifier]
 */

import { researchEffort, type ResearchEffort } from './research-effort.js'

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'
import type {
  DecisionExecutionPort,
  DecisionResponse,
} from '../decisions/index.js'

const CLASSIFIER_SYSTEM_PROMPT = `You are an isolated research-assessment worker. Decide whether the current request needs fresh multi-source investigation and choose the smallest sufficient effort.
Return JSON only. No explanation.

Input is JSON with:
- currentMessage: the message to classify.
- recentConversation: up to six earlier user/assistant text turns, oldest first.

Use recentConversation to resolve whether currentMessage is a follow-up. A follow-up that only explains, reframes, or strategizes material already discussed is OFF.
A follow-up that needs NEW evidence, source verification or a new comparison can be ON.
Assess the current evidence need, not whether the word research appears.

Research mode is ON when the request needs MULTI-SOURCE INVESTIGATION — multi-source web synthesis,
comparative analysis across products / papers / events, in-depth competitive scans, structured
reports, anything where the user is asking the assistant to act like an analyst.

Research mode is OFF for:
- Greetings, acknowledgments, casual chat
- Simple factual lookups answerable in one step ("what time is it in Tokyo")
- Quick how-to questions
- Follow-ups answerable from the supplied conversation without fresh investigation
- Tasks the assistant can do with its own memory + a couple of tool calls
- Requests to summarize or rewrite existing material without new evidence

A short request can still need research. Choose effort according to scope, uncertainty and evidence needed:
- focused: one bounded question or narrow comparison; two independent angles, one wave.
- standard: several questions needing cross-source comparison; three workers, up to two waves.
- deep: broad or explicitly exhaustive investigation, substantial uncertainty or conflicting evidence; five workers, up to four waves.
Use the smallest sufficient effort. Never choose deep merely because the user says research.

Research mode is OFF — and this is a SITE OPERATION — when the user asks to open, browse,
log into, or act on ONE specific named website / web app / URL ("browse luma for events in hk",
"log into stripe and download the latest invoice", "check what's listed on lu.ma"). Getting
information from one named site is a site operation, not research. Broad multi-site
investigation ("research the HK events landscape") is still research even if sites are named.
This holds in EVERY language, and asking for the computer/browser BY NAME is always a site
operation ("用 computer use 去睇下要幾錢", "幫我上官網睇下價錢", "ブラウザで公式サイトを見て").

If research warranted: {"research":true,"effort":"focused|standard|deep","reason":"<one short phrase, lower-case>"}
If a site operation: {"research":false,"operate_site":true}
Otherwise: {"research":false}`

const MIN_MESSAGE_LENGTH = 40
const CLASSIFIER_MODEL = 'gemini-3.5-flash-lite'

// ── CJK-aware effective length ─────────────────────────────────────
//
// A CJK character carries roughly a word of content (~4 chars of English),
// so a raw `message.length` bar is CJK-hostile: the 2026-07-16 incident
// message "cx sc credit card 而家個迎新係點" is 26 raw chars — a complete
// current-offer question that never reached the classifier and got a
// confabulated zero-tool answer. Weight each CJK char as 4 so substantive
// Cantonese/Chinese/Japanese asks clear the same bar English ones do.
// Same bug class as the windowed CJK-aware extraction bound (2026-07-15
// Cantonese transcription incident).
const CJK_CHAR =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g

function effectiveLength(message: string): number {
  const cjkCount = (message.match(CJK_CHAR) ?? []).length
  return message.length + cjkCount * 3
}

export type ResearchClassifyOptions = {
  /** Original canonical invocation and complete privately bound classifier inputs. */
  authority?: SessionContextAuthority
  assertInputAuthority?: () => Promise<void>
  signal?: AbortSignal
  provider: LLMProvider
  message: string
  /**
   * Recent visible dialogue, oldest first. This is what makes the prompt's
   * "follow-ups are OFF" rule actionable instead of asking the classifier to
   * infer conversation state from one isolated sentence.
   */
  recentConversation?: Array<{ role: 'user' | 'assistant'; text: string }>
  /** Maximum effective length for the trivial-chat fast path; defaults to 40. */
  minMessageLength?: number
  /**
   * Background-lane model. Callers with boot context (the API routes) pass an
   * id already checked servable against the configured providers; the default
   * keeps standalone/test use on the historical literal.
   */
  model?: string
  /** Provider-neutral decision cascade. Omitted preserves the legacy call. */
  decisionRuntime?: DecisionExecutionPort
  workspaceId?: string
  runId?: string
}

export type ResearchClassifyResult = {
  /** Whether the classifier flagged the message as needing research mode. */
  research: boolean
  /** Smallest sufficient research effort; absent for ordinary/site requests. */
  effort?: ResearchEffort
  /**
   * The message asks to open / browse / log into / act on ONE specific named
   * site or URL — a site operation, not research. Mutually exclusive with
   * `research`. The chat route uses this to keep the turn on the normal query
   * loop (full tool surface, incl. computer-use) instead of entering
   * coordinator mode, whose toolset structurally excludes every browser tool
   * (incident 2026-07-13: "browse luma" → 69-webSearch coordinator fan-out).
   * Spec: docs/architecture/engine/coordinator-pattern.md → "Adaptive entry
   * and the operate-site override".
   */
  operateSite: boolean
  /** Optional one-phrase reason the classifier emitted (telemetry only). */
  reason: string | null
  /** Token usage from the classifier call — null when no call was made. */
  usage: TokenUsage | null
  /** Model used for the call — null when no call was made. */
  model: string | null
}

// ── Operate-site deterministic fast-path ──────────────────────────
//
// Strong verbs are inherently site operations ("browse X", "log into X",
// "sign in to X") — no URL required. The denylist keeps "browse the web /
// the internet / online" research-eligible. Weak verbs ("open", "go to",
// "visit", "check", …) are everyday words, so they only count next to a
// URL-ish token (http(s)://, www., or a bare domain like lu.ma).
//
// English-only by construction — the LLM verdict in the classifier prompt is
// the language-agnostic recall net. False positives are cheap: the normal
// loop keeps spawnWorker + webSearch, so a misrouted research ask degrades
// to ordinary tooling; a false negative costs a multi-worker search fan-out
// on a task the browser answers in one call. Bias accordingly.
const STRONG_OPERATE_VERB = /\b(?:browse|computer\s+use|log(?:\s+(?:me|us))?\s*in(?:to)?|sign(?:\s+(?:me|us))?\s*in(?:to)?)\b/i
const STRONG_OPERATE_DENY = /\b(?:browse|log(?:\s+(?:me|us))?\s*in(?:to)?|sign(?:\s+(?:me|us))?\s*in(?:to)?)\s+(?:the\s+(?:web|internet)|online)\b/i
const WEAK_OPERATE_VERB = /\b(?:open|go\s+to|goto|visit|navigate\s+to|pull\s+up|look\s+at|check)\b/i
const URLISH = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\b/i
// CJK operate verbs. `\b` never matches around CJK characters (they are not
// `\w` in JS regex), so these live in boundary-free patterns. Strong: an
// explicit browse/open-site verb. Weak: everyday motion/look verbs (去/上/
// 睇/查/看/開), which — like the English weak verbs — only count next to a
// URL-ish token. False positives are cheap (the normal loop keeps webSearch);
// a false negative sends a Cantonese "幫我用 computer use 去睇價錢" into the
// coordinator, which has NO browser tools (2026-07-15 incident).
const STRONG_OPERATE_VERB_CJK = /瀏覽|浏览|打開網[站頁]|打开网[站页]|上網站|上网站/
const WEAK_OPERATE_VERB_CJK = /[去上開开睇查看]/

/**
 * Deterministic operate-site detection — the zero-cost fast-path in front of
 * `classifyResearchIntent`, also used standalone by the chat route for turns
 * the adaptive classifier never sees (`mode: 'default'`, ineligible callers).
 */
export function detectOperateSiteIntent(message: string): boolean {
  if (STRONG_OPERATE_VERB.test(message) && !STRONG_OPERATE_DENY.test(message)) return true
  if (STRONG_OPERATE_VERB_CJK.test(message)) return true
  return (WEAK_OPERATE_VERB.test(message) || WEAK_OPERATE_VERB_CJK.test(message)) && URLISH.test(message)
}

const RESEARCH_OPERATION = {
  id: 'research.intent',
  version: '2',
  stateVersion: '1',
  questionVersion: '2',
} as const

function primaryResearchResult(response: DecisionResponse): ResearchClassifyResult | null {
  const answer = response.answers[0]
  if (answer?.kind !== 'choice') return null
  const common = {
    usage: response.usage
      ? { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens }
      : null,
    model: response.model.wireId,
  }
  if (['research', 'research_focused', 'research_deep'].includes(answer.value)) {
    const effort = answer.value === 'research_focused' ? 'focused' : answer.value === 'research_deep' ? 'deep' : 'standard'
    return { research: true, effort, operateSite: false, reason: 'research_classifier', ...common }
  }
  if (answer.value === 'operate_site') {
    return { research: false, operateSite: true, reason: 'operate_site_classifier', ...common }
  }
  if (answer.value === 'ordinary') {
    return { research: false, operateSite: false, reason: null, ...common }
  }
  return null
}

function validateResearchResult(result: ResearchClassifyResult): ResearchClassifyResult {
  if (result.research && result.operateSite) throw new Error('research and operateSite are mutually exclusive')
  if (typeof result.research !== 'boolean' || typeof result.operateSite !== 'boolean') {
    throw new Error('research classifier returned an invalid result')
  }
  return result
}

async function classifyResearchWithLlm(params: {
  assertInputAuthority?: () => Promise<void>
  signal?: AbortSignal
  provider: LLMProvider
  model: string
  message: string
  recentConversation: Array<{ role: 'user' | 'assistant'; text: string }>
}): Promise<ResearchClassifyResult> {
  await assertInputAuthority(params.assertInputAuthority)
  const stream = params.provider.stream({
    assertInputAuthority: params.assertInputAuthority,
    signal: params.signal,
    model: params.model,
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        currentMessage: params.message,
        recentConversation: params.recentConversation,
      }),
    }],
    maxTokens: 128,
    temperature: 0,
  })

  const response = await collectStream(stream)
  await assertInputAuthority(params.assertInputAuthority)
  const text = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { research: false, operateSite: false, reason: null, usage: response.usage, model: response.model || params.model }
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    research?: unknown
    effort?: unknown
    operate_site?: unknown
    reason?: unknown
  }
  if (parsed.research !== true) {
    return {
      research: false,
      operateSite: parsed.operate_site === true,
      reason: parsed.operate_site === true ? 'operate_site_classifier' : null,
      usage: response.usage,
      model: response.model || params.model,
    }
  }
  return {
    research: true,
    effort: researchEffort(parsed.effort),
    operateSite: false,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    usage: response.usage,
    model: response.model || params.model,
  }
}

/**
 * Classify whether a user message should automatically enter research mode.
 *
 * Returns `research: true` only when the model is confident. Any error or
 * malformed JSON degrades to `research: false` — the safe default keeps the
 * cheap path on. Caller is responsible for plan / quota gating; this
 * classifier just answers the intent question.
 */
async function classifyResearchIntentCurrent(
  options: ResearchClassifyOptions,
): Promise<ResearchClassifyResult> {
  const { provider, message, minMessageLength = MIN_MESSAGE_LENGTH } = options
  const model = options.model ?? CLASSIFIER_MODEL

  // Operate-site fast-path — before the length check (site operations are
  // length-independent) and before the LLM call (zero classifier cost).
  if (detectOperateSiteIntent(message)) {
    return { research: false, operateSite: true, reason: 'operate_site_fast_path', usage: null, model: null }
  }

  // Only clearly trivial short chat bypasses assessment. A short substantive
  // question can need several sources without containing a research keyword.
  if (!message.trim() || (effectiveLength(message) <= minMessageLength && isTrivialChatMessage(message))) {
    return { research: false, operateSite: false, reason: null, usage: null, model: null }
  }

  const recentConversation = (options.recentConversation ?? [])
    .filter((turn) => turn.text.trim().length > 0)
    .slice(-6)
    .map((turn) => ({ role: turn.role, text: turn.text.trim().slice(0, 2000) }))

  if (options.decisionRuntime) {
    const result = await options.decisionRuntime.run({
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      llm: { provider, modelId: model },
      request: {
        runId: options.runId ?? `research-intent-${Date.now()}`,
        operation: RESEARCH_OPERATION,
        state: { currentMessage: message, recentConversation },
        assertInputAuthority: options.assertInputAuthority,
        signal: options.signal,
        questions: [{
          kind: 'choice',
          id: 'intent',
          prompt: 'Assess fresh evidence needs using recent dialogue. Existing-context explanation is ordinary; new evidence can require research even in a short follow-up. Choose the smallest sufficient research effort. One named site is a site operation.',
          options: [
            { value: 'ordinary', description: 'Normal request or contextual follow-up' },
            { value: 'research_focused', description: 'Narrow multi-source investigation: two angles, one wave' },
            { value: 'research', description: 'Standard multi-source comparison: three workers, two waves' },
            { value: 'research_deep', description: 'Broad, exhaustive or conflicting evidence: five workers, four waves' },
            { value: 'operate_site', description: 'Open, browse, log into, or act on one named site' },
          ],
        }],
      },
      operation: {
        decide(response, { profile }) {
          const answer = response.answers[0]
          const probabilities = answer?.evidence.probabilities
          const policy = profile?.policy
          const reviewBelow = typeof policy === 'object' && policy !== null && !Array.isArray(policy)
            && typeof policy.reviewBelow === 'number'
            ? policy.reviewBelow
            : undefined
          if (
            reviewBelow !== undefined && probabilities &&
            Math.max(...Object.values(probabilities)) < reviewBelow
          ) {
            return { kind: 'follow_up', reason: 'uncertain' }
          }
          const result = primaryResearchResult(response)
          return result
            ? { kind: 'complete', result }
            : { kind: 'unavailable', reason: 'invalid_response' }
        },
        validateResult: validateResearchResult,
        safeFailure: () => ({ research: false, operateSite: false, reason: null, usage: null, model: null }),
        async completeWithLlm(context) {
          const result = await classifyResearchWithLlm({
            provider: context.llm.provider,
            assertInputAuthority: options.assertInputAuthority,
            signal: options.signal,
            model: context.llm.modelId,
            message,
            recentConversation,
          })
          return {
            result,
            providerId: context.llm.provider.name,
            model: { catalogId: context.llm.modelId, wireId: result.model ?? context.llm.modelId },
            ...(result.usage ? {
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              },
            } : {}),
          }
        },
      },
    })
    return result.result
  }

  try {
    return await classifyResearchWithLlm({ provider, model, message, recentConversation, assertInputAuthority: options.assertInputAuthority, signal: options.signal })
  } catch (error) {
    if (isInputAuthorityError(error)) throw error
    await assertInputAuthority(options.assertInputAuthority)
    // Any ordinary failure → safe default, no research. Usage is lost because the
    // stream didn't complete; caller records nothing.
    return { research: false, operateSite: false, reason: null, usage: null, model: null }
  }
}

/** Complete admitted classifier inputs survive deterministic paths and provider fallback. */
export async function classifyResearchIntent(options: ResearchClassifyOptions): Promise<ResearchClassifyResult> {
  const inputs=boundScopeSources(options),authority=options.authority
  if(authority){
    if(!inputs.length||typeof options.assertInputAuthority!=='function')throw new DerivedScopeError('scope_evidence_missing')
    authority.accumulator.note({sources:inputs})
  } else if(inputs.length)throw new DerivedScopeError('scope_evidence_missing')
  let refusal:unknown,pending:Promise<void>|undefined
  const check=async()=>{
    if(refusal)throw refusal
    if(pending)return pending
    pending=(async()=>{
      if(authority){
        await assertInputAuthority(()=>authority.execution.security.authority.assertCurrent())
        if(authority.execution.lifecycle.abortSignal.aborted)throw Object.assign(new Error('The classifier context is unavailable.'),{reason:'authority_changed',retrySafe:false})
      }
      await assertInputAuthority(options.assertInputAuthority)
    })().catch(error=>{refusal=error;throw error})
    try{await pending}finally{pending=undefined}
  }
  await check()
  const input=structuredClone({message:options.message,recentConversation:options.recentConversation})
  const observed=authority?structuredClone(authority.accumulator.evidence.sources??[]):inputs
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),...(authority?[authority.execution.lifecycle.abortSignal]:[])])
  let result:ResearchClassifyResult
  try{result=await classifyResearchIntentCurrent({...options,...input,signal,assertInputAuthority:check})}
  catch(error){
    if(isInputAuthorityError(error))throw error
    await check()
    result={research:false,operateSite:false,reason:null,usage:null,model:null}
  }
  await check()
  return bindScopeSources(result,observed)
}
