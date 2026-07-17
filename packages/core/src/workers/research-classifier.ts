/**
 * Pre-flight classifier for adaptive research-mode entry.
 *
 * Decides whether a user message warrants research mode — the same flag the
 * web composer's manual toggle sets. When true, the chat / channel route
 * upgrades the model (Pro 3.1), raises the per-turn budget, and (on chat)
 * spins up worker delegation. Skipped for short messages and for callers
 * outside the research-eligible plan tier.
 *
 * Uses Gemini 3.1 Flash Lite — cheap classifier, JSON-only output. Mirrors
 * the pattern in `splitter.ts`.
 *
 * [COMP:workers/research-classifier]
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import { collectStream } from '../providers/accumulator.js'

const CLASSIFIER_SYSTEM_PROMPT = `You decide if a user message warrants deep research mode.
Return JSON only. No explanation.

Research mode is ON when the request needs DEEP INVESTIGATION — multi-source web synthesis,
comparative analysis across products / papers / events, in-depth competitive scans, structured
reports, anything where the user is asking the assistant to act like an analyst.

Research mode is OFF for:
- Greetings, acknowledgments, casual chat
- Simple factual lookups answerable in one step ("what time is it in Tokyo")
- Quick how-to questions
- Follow-ups that reference prior conversation context
- Tasks the assistant can do with its own memory + a couple of tool calls
- Messages under ~10 words

Research mode is OFF — and this is a SITE OPERATION — when the user asks to open, browse,
log into, or act on ONE specific named website / web app / URL ("browse luma for events in hk",
"log into stripe and download the latest invoice", "check what's listed on lu.ma"). Getting
information from one named site is a site operation, not research. Broad multi-site
investigation ("research the HK events landscape") is still research even if sites are named.
This holds in EVERY language, and asking for the computer/browser BY NAME is always a site
operation ("用 computer use 去睇下要幾錢", "幫我上官網睇下價錢", "ブラウザで公式サイトを見て").

If research warranted: {"research":true,"reason":"<one short phrase, lower-case>"}
If a site operation: {"research":false,"operate_site":true}
Otherwise: {"research":false}`

const MIN_MESSAGE_LENGTH = 40
const CLASSIFIER_MODEL = 'gemini-3.1-flash-lite'

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
  provider: LLMProvider
  message: string
  /** Override the short-message bypass; defaults to 40 chars. */
  minMessageLength?: number
}

export type ResearchClassifyResult = {
  /** Whether the classifier flagged the message as needing research mode. */
  research: boolean
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

/**
 * Classify whether a user message should automatically enter research mode.
 *
 * Returns `research: true` only when the model is confident. Any error or
 * malformed JSON degrades to `research: false` — the safe default keeps the
 * cheap path on. Caller is responsible for plan / quota gating; this
 * classifier just answers the intent question.
 */
export async function classifyResearchIntent(
  options: ResearchClassifyOptions,
): Promise<ResearchClassifyResult> {
  const { provider, message, minMessageLength = MIN_MESSAGE_LENGTH } = options

  // Operate-site fast-path — before the length check (site operations are
  // length-independent) and before the LLM call (zero classifier cost).
  if (detectOperateSiteIntent(message)) {
    return { research: false, operateSite: true, reason: 'operate_site_fast_path', usage: null, model: null }
  }

  // Short messages never warrant research — short-circuit before the LLM
  // call. Length is CJK-weighted (see `effectiveLength`) so a compact
  // Cantonese/Chinese ask is not mistaken for a greeting.
  if (effectiveLength(message) <= minMessageLength) {
    return { research: false, operateSite: false, reason: null, usage: null, model: null }
  }

  try {
    const stream = provider.stream({
      model: CLASSIFIER_MODEL,
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: message }],
      maxTokens: 128,
      temperature: 0,
    })

    const response = await collectStream(stream)
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { research: false, operateSite: false, reason: null, usage: response.usage, model: CLASSIFIER_MODEL }
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      research?: unknown
      operate_site?: unknown
      reason?: unknown
    }
    if (parsed.research !== true) {
      return {
        research: false,
        operateSite: parsed.operate_site === true,
        reason: parsed.operate_site === true ? 'operate_site_classifier' : null,
        usage: response.usage,
        model: CLASSIFIER_MODEL,
      }
    }
    return {
      research: true,
      operateSite: false,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      usage: response.usage,
      model: CLASSIFIER_MODEL,
    }
  } catch {
    // Any failure → safe default, no research. Usage is lost because the
    // stream didn't complete; caller records nothing.
    return { research: false, operateSite: false, reason: null, usage: null, model: null }
  }
}
