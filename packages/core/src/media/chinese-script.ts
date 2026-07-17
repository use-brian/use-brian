/**
 * Chinese script normalization — the `chineseScript` half of the workspace
 * transcription preference (`workspaces.transcription_prefs`, migration 332).
 *
 * Providers pick their own script convention (Scribe emits Simplified for
 * auto-detected Chinese; Gemini's prompt asks for Traditional 粵文), so a
 * workspace that wants "any Chinese in Traditional characters" needs a
 * conversion that runs AFTER transcription, whatever provider the ladder
 * landed on. OpenCC dictionaries do that conversion: one-to-many mappings
 * (发→發/髮) resolve by context dictionary, and non-Han text (English, digits,
 * punctuation, emoji) passes through byte-identical — code-switched
 * utterances survive untouched.
 *
 * `'traditional'` targets the Hong Kong variant (cn→hk — the Cantonese-market
 * convention this preference exists for); `'simplified'` converts generic
 * Traditional to Simplified (t→cn).
 *
 * `opencc-js` loads its dictionaries at import time (~MBs), so the import is
 * lazy — nothing pays for it until a workspace actually sets the preference.
 * Converters are memoized after first use.
 *
 * Spec: docs/architecture/media/transcription.md §"Language & script
 * preferences".
 */

export type ChineseScript = 'traditional' | 'simplified'

// CJK Unified Ideographs + Extension A + Compatibility Ideographs — enough to
// decide "does this string carry Chinese characters at all".
const HAN_RE = /[㐀-䶿一-鿿豈-﫿]/

type ConverterFn = (text: string) => string

const converters = new Map<ChineseScript, Promise<ConverterFn>>()

function converterFor(target: ChineseScript): Promise<ConverterFn> {
  let converter = converters.get(target)
  if (!converter) {
    converter = import('opencc-js').then((OpenCC) =>
      target === 'traditional'
        ? OpenCC.Converter({ from: 'cn', to: 'hk' })
        : OpenCC.Converter({ from: 't', to: 'cn' }),
    )
    converters.set(target, converter)
  }
  return converter
}

/** True when the string contains at least one Han character. */
export function containsHan(text: string): boolean {
  return HAN_RE.test(text)
}

/**
 * Convert every string's Han characters to the target script. Strings without
 * Han characters are returned as-is; an all-Latin batch never even loads the
 * dictionaries. Output array is index-aligned with the input.
 */
export async function convertChineseScript(
  texts: string[],
  target: ChineseScript,
): Promise<string[]> {
  if (!texts.some((t) => HAN_RE.test(t))) return texts
  const convert = await converterFor(target)
  return texts.map((t) => (HAN_RE.test(t) ? convert(t) : t))
}
