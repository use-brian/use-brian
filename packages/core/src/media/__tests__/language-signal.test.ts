/**
 * Language signal over a finished transcript.
 *
 * Spec: docs/plans/transcription-language-observability.md
 */

import { describe, expect, it } from 'vitest'
import { CANTO_MARKER_CHARS, languageSignal } from '../language-signal.js'

const utt = (text: string) => ({ startMs: 0, endMs: 1_000, speaker: null, text })

describe('[COMP:media/language-signal] languageSignal density', () => {
  // The feature in one assertion: the same sentence, spoken in Cantonese and
  // normalized into Standard Written Chinese, must be tellable apart. If this
  // does not hold, none of the recorded data means anything.
  //
  // Counted by hand against the canonical marker set, not by re-running the
  // implementation: 我哋今日喺屋企食飯，佢話唔嚟喇 carries 14 CJK characters
  // (the fullwidth comma is not CJK) of which 喺 佢 唔 嚟 喇 are markers — 哋
  // is deliberately absent from the set. 5/14 → 357 per 1000.
  it('separates verbatim Cantonese from the same sentence normalized to Standard Written Chinese', () => {
    const cantonese = languageSignal([utt('我哋今日喺屋企食飯，佢話唔嚟喇')])
    const normalized = languageSignal([utt('我们今天在家里吃饭，他说不来了')])

    expect(cantonese.cantoDensityPerK).toBe(357)
    expect(normalized.cantoDensityPerK).toBe(0)
  })

  // A ratio of markers to the CJK they are drawn from cannot exceed 1000 per
  // 1000 — unless the two are counted over different character ranges, which
  // is exactly the defect this pins. 㗎 (U+35CE) lives in CJK Extension A,
  // outside the `一-鿿` Unified block, so a numerator that counts it against a
  // denominator that does not yields a density above its own ceiling.
  //
  // Stated over the whole set rather than one character, so that widening the
  // markers later without widening the CJK range fails here rather than in
  // production data.
  it('never reports a density above 1000, whichever markers the set carries', () => {
    const everyMarker = languageSignal([utt(CANTO_MARKER_CHARS)])

    expect(everyMarker.cantoDensityPerK).toBe(1000)
  })

  // A density is a ratio, and a ratio taken over 14 characters carries nothing
  // like the weight of one taken over 50,000. Storing the raw counts next to it
  // is what lets an aggregate weight the recordings instead of averaging the
  // averages. Same hand count as the case above: 5 markers, 14 CJK.
  it('reports the raw marker and CJK counts the density was taken over', () => {
    const s = languageSignal([utt('我哋今日喺屋企食飯，佢話唔嚟喇')])

    expect(s.markerCount).toBe(5)
    expect(s.cjkCount).toBe(14)
  })

  // Counts are over the whole recording, not the first thing said in it. A
  // chunked transcription arrives as many utterances and must measure the same
  // as if it had arrived as one.
  it('aggregates counts across every utterance in the recording', () => {
    const split = languageSignal([utt('我哋今日喺屋企食飯'), utt('佢話唔嚟喇')])
    const whole = languageSignal([utt('我哋今日喺屋企食飯佢話唔嚟喇')])

    expect(split.markerCount).toBe(whole.markerCount)
    expect(split.cjkCount).toBe(whole.cjkCount)
    expect(split.cantoDensityPerK).toBe(whole.cantoDensityPerK)
  })
})

describe('[COMP:media/language-signal] languageSignal code-switching', () => {
  // HK speech drops English words mid-sentence, and those tokens are the
  // code-switch signal rather than noise. They must not land in the CJK count:
  // inflating the denominator would dilute the density of exactly the
  // recordings this metric cares most about.
  //
  // Hand-counted: 佢話唔記得…個…畀我，我睇完再…佢 is 13 CJK characters, and
  // send / email / reply are the three Latin tokens.
  it('counts Latin tokens without letting them dilute the CJK denominator', () => {
    const s = languageSignal([utt('佢話唔記得send個email畀我，我睇完再reply佢')])

    expect(s.latinTokens).toBe(3)
    expect(s.cjkCount).toBe(13)
  })
})

describe('[COMP:media/canto-filter] languageSignal variant label', () => {
  // Density measures Cantonese PRESENCE, so a Mandarin transcript and an
  // English one both score 0 markers and are indistinguishable by it. The
  // four-way label is what separates them, and telling "the provider
  // normalized to Mandarin" from "there was no Chinese here" is the reason the
  // metric exists at all.
  it('separates Mandarin from merely-no-markers, which density cannot', () => {
    const cantonese = languageSignal([utt('我哋今日喺屋企食飯，佢話唔嚟喇')])
    const mandarin = languageSignal([utt('我們今天在家裡吃飯，他說不來了')])
    const english = languageSignal([utt('We should ship the eval harness first.')])

    expect(cantonese.variant).toBe('cantonese')
    expect(mandarin.variant).toBe('mandarin')
    expect(english.variant).toBe('neutral')

    // The point: density alone collapses the last two together.
    expect(mandarin.cantoDensityPerK).toBe(0)
    expect(english.cantoDensityPerK).toBeNull()
  })

  // Characterization, not red-first: `canto-filter.ts` is a verbatim port of
  // the published CanCLID classifier, brought in whole because a partial port
  // means partial regexes and a wrong answer. These pin the upstream behaviour
  // a hand-rolled marker count cannot express at all — a Mandarin-feature
  // character sitting inside a loanword, where it is not evidence of anything.
  it('treats Mandarin-feature characters inside loanwords as innocent', () => {
    // 那 is a Mandarin feature; 剎那 is a loanword, so it is not evidence.
    expect(languageSignal([utt('剎那之間')]).variant).toBe('neutral')
    // 的 likewise inside 的士, in a sentence that is otherwise Cantonese.
    expect(languageSignal([utt('我哋搭的士去')]).variant).toBe('cantonese')
    // Bare 的 outside a loanword IS evidence.
    expect(languageSignal([utt('我的書')]).variant).toBe('mandarin')
  })
})

describe('[COMP:media/language-signal] languageSignal null and zero', () => {
  // "English recording" and "Chinese recording carrying no Cantonese" are the
  // two things this metric exists to tell apart. Collapsing both to 0 would
  // drag every English recording into the Cantonese statistics; collapsing
  // both to null would hide the normalization this was built to catch. The
  // pair is asserted together because neither half means anything alone.
  it('distinguishes no-CJK (null) from CJK-without-markers (zero)', () => {
    const englishOnly = languageSignal([utt('We should ship the eval harness first.')])
    const chineseNoMarkers = languageSignal([utt('我们今天在家里吃饭')])

    expect(englishOnly.cantoDensityPerK).toBeNull()
    expect(englishOnly.cjkCount).toBe(0)
    expect(chineseNoMarkers.cantoDensityPerK).toBe(0)
    expect(chineseNoMarkers.cjkCount).toBeGreaterThan(0)
  })

  // A recording can produce nothing at all — a silent file, or one whose
  // utterances were all dropped by the degeneracy guard. Measuring it must
  // report "unmeasurable", never a divide-by-zero or a spurious 0.
  it('reports an unmeasurable density for empty and whitespace-only transcripts', () => {
    for (const empty of [languageSignal([]), languageSignal([utt('   \n  ')])]) {
      expect(empty.cantoDensityPerK).toBeNull()
      expect(empty.markerCount).toBe(0)
      expect(empty.cjkCount).toBe(0)
      expect(empty.latinTokens).toBe(0)
      expect(empty.variant).toBe('neutral')
    }
  })

  // The marker set omits 係 and 都 because both are ordinary in Standard
  // Written Chinese compounds (關係, 首都). If they were included, the very
  // Mandarin-normalized output this metric exists to detect would score as
  // Cantonese — the failure mode would become invisible in its own metric.
  it('does not score Standard Written Chinese compounds as Cantonese', () => {
    const swc = languageSignal([utt('這個關係很重要，首都在北京')])

    expect(swc.cantoDensityPerK).toBe(0)
    expect(swc.markerCount).toBe(0)
  })
})
