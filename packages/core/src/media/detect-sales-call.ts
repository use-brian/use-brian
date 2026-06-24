/**
 * Heuristic sales-call detector (recording-to-brain). After a recording is
 * transcribed, this decides whether to route the transcript through the
 * `sales-call-capture` skill (extract contacts / company / deal / next-step
 * tasks into the brain). Pure + cheap (no LLM) so it gates the more expensive
 * extraction; the skill itself does the real work.
 *
 * Signal model: count hits across four orthogonal categories of sales language.
 * A single category firing (e.g. someone says "budget" once in an all-hands)
 * is not a sales call; we require BREADTH (multiple categories) plus a minimum
 * total density, so internal standups / 1:1s don't trip it.
 *
 * Spec: docs/plans/recording-to-brain.md (sales-call skill).
 */

export type SalesCallDetection = {
  isSalesCall: boolean
  /** 0..1 confidence: categories-hit breadth blended with density. */
  score: number
  /** The distinct signal phrases that fired, for explainability / logging. */
  signals: string[]
  categoriesHit: number
}

const SIGNAL_CATEGORIES: Record<string, RegExp[]> = {
  commercial: [
    /\bpricing\b/i, /\bprice\b/i, /\bquote\b/i, /\bdiscount\b/i, /\bbudget\b/i,
    /\bcontract\b/i, /\bproposal\b/i, /\bSOW\b/i, /\bprocurement\b/i,
    /\blicen[sc]e\b/i, /\bsubscription\b/i, /\brenewal\b/i, /\bROI\b/i,
    /\bper seat\b/i, /\bannual\b/i, /\bcost\b/i,
  ],
  discovery: [
    /\buse case\b/i, /\bpain point\b/i, /\brequirements?\b/i, /\bevaluat/i,
    /\bcurrent (solution|tool|vendor|provider)\b/i, /\bdecision maker\b/i,
    /\bstakeholders?\b/i, /\btimeline\b/i, /\bPOC\b/i, /\bpilot\b/i,
    /\bdemo\b/i, /\bonboarding\b/i, /\bintegrat/i,
  ],
  commitment: [
    /\bnext steps?\b/i, /\bfollow ?up\b/i, /\bsend (you |over |it )/i,
    /\bby (friday|monday|tuesday|wednesday|thursday|end of (the )?week|eow|next week)\b/i,
    /\bcircle back\b/i, /\baction items?\b/i, /\bschedule (a |the )?(call|demo|meeting|follow)/i,
    /\bget back to you\b/i, /\bloop in\b/i,
  ],
  prospect: [
    /\bprospect\b/i, /\byour team\b/i, /\byour company\b/i, /\bour (product|platform|solution)\b/i,
    /\bdeal\b/i, /\bopportunity\b/i, /\bclose (the deal|this|by)\b/i,
    /\bchampion\b/i, /\bcompetitor\b/i, /\bobjection\b/i,
  ],
}

/**
 * Classify a transcript (or any joined call text). `isSalesCall` requires at
 * least 2 distinct categories AND >= 4 total signal hits — breadth + density.
 */
export function detectSalesCall(text: string): SalesCallDetection {
  const signals: string[] = []
  let categoriesHit = 0
  let totalHits = 0

  for (const patterns of Object.values(SIGNAL_CATEGORIES)) {
    let categoryFired = false
    for (const re of patterns) {
      const m = re.exec(text)
      if (m) {
        totalHits++
        categoryFired = true
        if (!signals.includes(m[0].toLowerCase())) signals.push(m[0].toLowerCase())
      }
    }
    if (categoryFired) categoriesHit++
  }

  const isSalesCall = categoriesHit >= 2 && totalHits >= 4
  // Score: half from category breadth (of 4), half from density (capped at 8 hits).
  const score = Math.min(1, categoriesHit / 4) * 0.5 + Math.min(1, totalHits / 8) * 0.5

  return { isSalesCall, score, signals, categoriesHit }
}
