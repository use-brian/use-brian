/**
 * Language signal over a finished transcript — the measurement half of
 * transcription language observability.
 *
 * The failure this exists to make visible is silent: Cantonese and Mandarin
 * share a writing system, so a provider asked to auto-detect does not report
 * "wrong language" — it reports Chinese, returns 200, and emits fluent Standard
 * Written Chinese where the speaker actually said 嘅/咗/唔. Nothing else in the
 * pipeline distinguishes that from a genuine Mandarin recording.
 *
 * Pure over the FINAL utterance list (after chunk merge / continuation), so a
 * recording produces exactly one measurement however it was transcribed.
 *
 * Spec: docs/plans/transcription-language-observability.md
 */

import { judgeChineseVariant, type ChineseVariant } from './canto-filter.js'

/**
 * Distinctly-Cantonese characters. Deliberately EXCLUDES 係/都 and friends,
 * which occur commonly in Standard Written Chinese compounds (關係, 係數) — a
 * Mandarin-normalized transcript must not be able to score as Cantonese.
 *
 * Do not "complete" this set without re-reading that constraint: adding
 * SWC-common characters silently destroys its discriminating power, which is
 * the entire point of the metric.
 *
 * This is the single definition — the eval harness imports it from here rather
 * than keeping a copy, so harness output and production numbers are the same
 * measurement rather than two drifting copies.
 */
export const CANTO_MARKER_CHARS = '嘅咗唔喺佢嗰啲冇睇嘢乜嚟㗎喇噉畀諗嗌攞郁掂靚嬲'

const CANTO_MARKERS = new RegExp(`[${CANTO_MARKER_CHARS}]`, 'g')

/**
 * The density denominator. Covers CJK Extension A (U+3400-U+4DBF) as well as
 * Unified (U+4E00-U+9FFF) because 㗎 (U+35CE) — a common sentence-final
 * particle, and a marker above — lives in Extension A.
 *
 * **Every character in `CANTO_MARKER_CHARS` must fall inside this range.** The
 * numerator and denominator are a ratio: count them over different ranges and
 * the density exceeds its own 1000 ceiling. Widening one requires widening the
 * other, and `language-signal.test.ts` fails if that ever stops holding.
 */
const CJK = /[㐀-䶿一-鿿]/g

const LATIN_TOKEN = /[A-Za-z][A-Za-z'-]*/g

export type LanguageSignal = {
  /**
   * Cantonese markers per 1000 CJK characters, or `null` when the transcript
   * carries no CJK at all. Null and 0 are NOT interchangeable: null is "not a
   * Chinese recording", 0 is "Chinese, carrying no Cantonese" — telling those
   * apart is the point of the metric, and folding null into 0 would drag every
   * English recording into the Cantonese statistics.
   */
  cantoDensityPerK: number | null
  /**
   * The raw counts the density was taken over. A ratio measured across 14
   * characters carries nothing like the weight of one measured across 50,000,
   * and storing both is what lets an aggregate weight recordings rather than
   * average the averages.
   */
  markerCount: number
  cjkCount: number
  /** Latin-script tokens — the code-switch signal. Never counted as CJK. */
  latinTokens: number
  /**
   * Four-way classification over the whole transcript, from the published
   * CanCLID classifier (see `canto-filter.ts`).
   *
   * This deliberately runs over a DIFFERENT and much wider character set than
   * the density above, and the two must not be merged. Density answers "how
   * Cantonese does this read, on the hand-curated scale the eval harness
   * scores with"; variant answers "which variety is this, by a citable
   * third-party method that also weighs positive Mandarin evidence and
   * suppresses loanword false positives". Collapsing them onto one set would
   * cost whichever answer lost its character classes.
   */
  variant: ChineseVariant
}

/** Measure how Cantonese a transcript reads. Pure. */
export function languageSignal(utterances: Array<{ text: string }>): LanguageSignal {
  const text = utterances.map((u) => u.text).join('\n')
  const cjkCount = (text.match(CJK) ?? []).length
  const markerCount = (text.match(CANTO_MARKERS) ?? []).length
  return {
    cantoDensityPerK: cjkCount > 0 ? Math.round((markerCount / cjkCount) * 1000) : null,
    markerCount,
    cjkCount,
    latinTokens: (text.match(LATIN_TOKEN) ?? []).length,
    variant: judgeChineseVariant(text),
  }
}
