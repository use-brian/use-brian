/**
 * Grounding gate — claims must be backed by evidence, and the linkage is
 * remembered.
 *
 * The mechanical guard behind the 2026-07-16 credit-card welcome-offer
 * incident: a Cantonese "what's the current welcome offer" question was
 * answered with fully confabulated figures in two consecutive turns with
 * ZERO tool calls, then re-asserted on dispute. Layer 1 already orders
 * "time-sensitive data: ALWAYS search first", but prompt rules do not bind
 * standard-tier models — the same lesson as the identifier-provenance
 * gate, applied to interactive reply text instead of record writes.
 *
 * v2 (same day): instead of only checking "did the model call any tool",
 * the gate extracts figure claims from the draft reply and diffs them
 * against the turn's `EvidenceAccumulator` figure index — so it also
 * catches turns that DID call tools but still invented half their figures,
 * names the exact offending values in the nudge, annotates whatever stays
 * unverified, and emits a claim ledger so the claim→evidence linkage is
 * persisted before the reply is delivered.
 *
 * Deterministic (regexes + set lookups, no LLM call); fires only on lanes
 * that opt in via the `groundingGate` query-loop option (interactive chat
 * + messaging channels). Spec: docs/architecture/engine/grounding-gate.md.
 *
 * [COMP:engine/grounding-gate]
 */

import {
  extractFigureClaims,
  type EvidenceAccumulator,
  type FigureClaim,
  type FigureSource,
} from '../security/evidence.js'

/**
 * Tools that count as web verification. Deliberately the narrow web set —
 * the gate exists for public-world facts; brain/memory retrieval cannot
 * verify a bank's current promotion. If none is bound, the nudge is
 * pointless (the model cannot search) and enforcement goes straight to the
 * trailer annotation.
 */
const WEB_VERIFICATION_TOOLS = ['webSearch', 'xSearch', 'urlReader'] as const

export function hasWebVerificationTool(tools: { has(name: string): boolean }): boolean {
  return WEB_VERIFICATION_TOOLS.some((name) => tools.has(name))
}

// ── Fresh-facts heuristic (two halves, both must match) ────────────
//
// The ENFORCEMENT scope trigger: the nudge/trailer fire only when the
// user's message asks about the current state of a volatile fact. A user
// asking for a *proposal* ("draft pricing for our new plan") legitimately
// receives invented figures — generative replies must not be policed. The
// claim LEDGER records on every figure-bearing reply regardless.
//
// Same shape as `stepAdvisories`' contact-research heuristic: one half
// alone is everyday chat ("call me now", "the offer we discussed"). `\b`
// never matches around CJK characters (not `\w` in JS regex), so the CJK
// halves live in boundary-free patterns — the same convention as the
// operate-site CJK verbs in research-classifier.ts.

const FRESHNESS_CUE = new RegExp(
  [
    /\b(?:right\s+now|now|current(?:ly)?|latest|today|tonight|this\s+(?:week|month|year)|these\s+days|as\s+of|up[\s-]to[\s-]date|recent(?:ly)?)\b/i
      .source,
    // yue/zh/ja: 而家·依家·宜家 (Cantonese "now"), 現時/現在/目前, 最新, 今日/今天,
    // 今個月/本月, 今年, 最近, 呢排/近排 (Cantonese "lately"), 現時点 (ja).
    /而家|依家|宜家|現時|现时|現在|现在|目前|最新|今日|今天|今個月|今个月|本月|今年|最近|呢排|近排|近來|近来|現時点/
      .source,
  ].join('|'),
  'i',
)

const VOLATILE_FACT_NOUN = new RegExp(
  [
    /\b(?:price|prices|pricing|cost|costs|fee|fees|rate|rates|offer|offers|promo(?:tion)?s?|deal|deals|discount|bonus|cashback|miles|points|interest|apr|stock|share\s+price|quote|schedule|timetable|deadline|availability|in\s+stock|news|score|scores|weather|forecast)\b/i
      .source,
    // 價錢/價格, 幾錢 (Cantonese "how much"), 收費/費用/年費, 利率/息口, 匯率,
    // 優惠 (offer), 迎新 (welcome offer), 折扣, 回贈 (rebate), 里數 (miles),
    // 積分, 股價, 新聞, 截止/死線 (deadline), 時間表/班次, 天氣, 賽果/比分,
    // ja: 価格/料金/金利/キャンペーン.
    /價[錢格]|价[钱格]|幾錢|幾多錢|几钱|几多钱|收費|收费|費用|费用|年費|年费|利率|息口|匯率|汇率|優惠|优惠|迎新|折扣|回贈|回赠|里數|里数|積分|积分|股價|股价|新聞|新闻|截止|死線|死线|時間表|时间表|班次|天氣|天气|賽果|赛果|比分|価格|料金|金利|キャンペーン/
      .source,
  ].join('|'),
  'i',
)

/**
 * Does the user message ask about the current state of a volatile fact?
 * Returns the matched freshness cue for telemetry (`matched_cue` on the
 * `grounding_nudge_fired` analytics event).
 */
export function matchFreshFactsQuestion(message: string): string | null {
  const cue = message.match(FRESHNESS_CUE)
  if (!cue) return null
  if (!VOLATILE_FACT_NOUN.test(message)) return null
  return cue[0]
}

// ── Claims evaluation ──────────────────────────────────────────────

export type ClaimVerdict = FigureClaim & {
  backed: boolean
  /** The tool result that backed the claim; `null` = seeded caller/user
   *  material; absent when unbacked. */
  source?: FigureSource | null
}

/**
 * Extract figure claims from the draft reply and diff each against the
 * run's evidence. No accumulator = nothing was observed = every claim is
 * unbacked (a lane that wires the gate without evidence still gets sound,
 * conservative behavior).
 */
export function evaluateClaims(
  draftText: string,
  evidence: Pick<EvidenceAccumulator, 'hasFigure' | 'figureSource'> | undefined,
): ClaimVerdict[] {
  return extractFigureClaims(draftText).map((claim) => {
    const backed = evidence?.hasFigure(claim.canonical) ?? false
    return backed
      ? { ...claim, backed, source: evidence!.figureSource(claim.canonical) }
      : { ...claim, backed }
  })
}

// ── Nudge + trailer copy ───────────────────────────────────────────

/**
 * The synthetic user message injected when unbacked claims exist on a
 * fresh-facts turn. Names the exact values (the actionable-error lesson
 * from the identifier gate) but no specific tool (tool-awareness rule) —
 * `hasWebVerificationTool` already guaranteed one exists.
 */
export function buildGroundingNudge(opts: {
  draftDelivered: boolean
  unbackedValues: string[]
}): string {
  const tail = opts.draftDelivered
    ? 'Your draft was already shown to the user — if verification changes any figure, open by correcting it explicitly.'
    : 'Your draft was NOT delivered to the user — the reply you write now is the only message they will see, so make it complete and standalone.'
  const listing = opts.unbackedValues.join(', ')
  return (
    `These figures in your reply appear in no tool result, instruction, or user message this turn: ${listing}. ` +
    'They came from your stale training data and are likely wrong. Do this now: ' +
    '(1) verify each one with your search / retrieval tools — search the topic, not the figure itself (a search query containing the figure cannot verify it); ' +
    "(2) rewrite your answer in the user's language using ONLY figures that appear in tool results, and say where they came from; " +
    '(3) if a figure is computed from verified figures, show the computation; ' +
    `(4) state anything you could not verify plainly as not verified — never guess, and never repeat an unverified figure from your draft. ${tail}`
  )
}

/**
 * Language-neutral enforcement backstop appended to the final text block
 * (and streamed as a text_delta) when claims stay unbacked after the nudge
 * — or when no verification tool was bound to nudge toward.
 */
export function buildUnverifiedTrailer(unbackedValues: string[]): string {
  return `\n\n⚠ Not verified against a source: ${unbackedValues.join(', ')}`
}

// ── Dispute pre-pass (the ledger's first consumer) ─────────────────
//
// The incident's second failure was re-assertion: the user disputed a
// figure and the model doubled down with more invented detail. When a user
// message is dispute-shaped AND carries a figure, the lane loads the
// previous reply's claim ledger and injects the provenance so the model
// re-verifies instead of re-asserting.

const DISPUTE_CUE =
  /唔係|唔啱|不是|不對|不对|冇可能|係咪真|睇真啲|isn'?t\s+it|that'?s\s+(?:wrong|not\s+right)|incorrect|are\s+you\s+sure|really\?|\bno\b[,\s]+it(?:'s|\s+is)/i

/** Dispute-shaped follow-up: a contradiction cue co-occurring with a
 *  figure claim ("唔係要 look 11萬咩"). */
export function matchesDisputedFigure(message: string): boolean {
  if (!DISPUTE_CUE.test(message)) return false
  return extractFigureClaims(message).length > 0
}

/**
 * Turn-context note injected by the lane when a dispute-shaped message
 * follows a reply with a claim ledger. Named-provenance, actionable — the
 * same lesson as the named-value nudge.
 */
export function buildDisputeContextNote(
  entries: Array<{ claim: string; status: 'backed' | 'unverified'; backedByToolName?: string }>,
): string {
  const lines = entries.map((e) =>
    `- ${e.claim} — ${
      e.status === 'backed'
        ? `backed by a ${e.backedByToolName ?? 'tool'} result this conversation`
        : 'UNVERIFIED (came from no source; it may well be wrong)'
    }`,
  )
  return (
    "The user appears to be disputing a figure from your previous reply. Provenance of that reply's figures:\n" +
    lines.join('\n') +
    '\nRe-verify the disputed figure with your tools before answering. Never re-assert an unverified figure — if you cannot verify it now, say so plainly and correct your earlier statement.'
  )
}

export type GroundingGateOptions = {
  /** The turn's raw user message text — the lane passes it explicitly
   *  rather than the loop re-parsing `messages` (resume shapes, envelopes). */
  userMessage: string
  /**
   * Whether the draft already reached the user when the gate fires. Web SSE
   * streams the draft live (true); final-only channels retract it via the
   * `grounding_nudge` event's buffer reset (false, the default). Branches
   * one sentence of the nudge copy so the model is never lied to about what
   * the user saw.
   */
  draftDelivered?: boolean
}
