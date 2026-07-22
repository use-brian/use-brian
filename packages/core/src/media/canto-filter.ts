/**
 * Cantonese / Standard-Written-Chinese classifier — a faithful TypeScript port
 * of CanCLID/canto-filter (`cantofilter/judge.py`).
 *
 *   Upstream: https://github.com/CanCLID/canto-filter  (MIT)
 *   Method:   Lau, Lau & To, "Cantonese Natural Language Processing in the
 *             Transformers Era" / canto-filter, EURALI @ LREC-COLING 2024
 *             https://aclanthology.org/2024.eurali-1.4/
 *
 * Why a port rather than a dependency: upstream ships Python only (no npm
 * package exists), and the algorithm is pure regex with no model files — so a
 * port is ~100 lines and carries no runtime cost. Character classes and the
 * decision tree are reproduced VERBATIM from upstream; do not "tidy" them.
 *
 * Note the `u` flag on every pattern: the Cantonese classes contain
 * astral-plane characters (𨋢 𥄫 𡃁 𨳍 …) which silently mis-match without it.
 *
 * Why this rather than a hand-curated marker list: the naive approach counts
 * Cantonese-looking characters and cannot tell "Mandarin" from "no markers",
 * nor suppress Mandarin loanwords that merely LOOK like Mandarin features
 * (剎那, 的士, 實事求是). Upstream solves both — MANDO_UNIQUE/MANDO_FEATURE give
 * positive Mandarin evidence, and MANDO_LOAN spans suppress the false
 * positives.
 *
 * Spec: docs/plans/transcription-language-observability.md
 */

/**
 * Cantonese-unique characters. Verbatim from upstream CANTO_UNIQUE_CHAR.
 *
 * Deliberately NOT exported. The density metric in `language-signal.ts` counts
 * over its own narrower hand-curated set (`CANTO_MARKER_CHARS`) and must not
 * borrow this one: this class contains astral-plane characters, and a density
 * numerator drawn from it against a BMP denominator exceeds its own 1000
 * ceiling. Keeping it private is what stops that from being re-wired.
 */
const CANTO_UNIQUE_CHAR =
  /[嘅嗰啲咗佢喺咁噉冇哋畀嚟諗惗乜嘢瞓睇餸𨋢摷嚿嚡嘥嗮啱喐逳噏攞𥄫攰癐冚孻冧𡃁嚫跣𨃩瀡氹凼嬲孭黐唞㪗埞忟𢛴踎脷厾]|[𢳂揾搵揦揈捹撳㩒掟揼抌揸㩧𢫏擳]|[撚閪𨳍𨳊𨶙𨳒]|[㗎𠺢喎噃啩𠿪啫嗱]/u

/** Cantonese-unique words. Verbatim from upstream CANTO_UNIQUE_WORD. */
const CANTO_UNIQUE_WORD =
  /唔[係得會想好識使洗駛通知到去走掂該錯差多少]|點[樣會做得解知]|[琴尋噚聽第]日|[而依]家|[真就實梗緊堅又話都但淨剩只定一]係|邊[度個位科]|[嚇凍攝整揩逢淥浸激][親嚫]|[橫搞傾得唔好]掂|仲[有係話要得好衰唔]|返[學工去翻番到]|[好得]返|執[好生實返輸]|[癡痴][埋線住起身]|[同帶做整溝炒煮]埋|[剩淨坐留]低|傾[偈計]|屋企|收皮|慳錢|屈機|隔籬|幫襯|求其|家陣|仆街|是[但旦]|[濕溼]碎|零舍|肉[赤緊酸]|核突|[勁隻][秋抽]|[呃𧦠][鬼人秤稱錢]/u

/** Mandarin-unique. Verbatim from upstream MANDO_UNIQUE. */
const MANDO_UNIQUE = /[這哪您們唄咱啥甭她]|還[是好有]|[事門塊勁花那點會]兒/u

/**
 * Mandarin features. Verbatim from upstream MANDO_FEATURE.
 * Upstream note: 在/不/把 are deliberately EXCLUDED — too many have been
 * absorbed into Cantonese for them to discriminate.
 */
const MANDO_FEATURE = /[那是的他它看吧沒麼么些了卻説說吃弄也]|而已/gu

/**
 * Mandarin loanwords — spans where a MANDO_FEATURE character is innocent
 * (剎那, 的士, 實事求是, 也門…). Verbatim from upstream MANDO_LOAN.
 */
const MANDO_LOAN =
  /亞利桑那|剎那|巴塞羅那|薩那|沙那|哈瓦那|印第安那|那不勒斯|支那|是[否日次非但旦]|[利於]是|唯命是從|頭頭是道|似是而非|自以為是|俯拾皆是|撩是鬥非|莫衷一是|唯才是用|馬首是瞻|實事求是|[目綠藍紅中飛]的|的[士確式色]|波羅的海|眾矢之的|的而且確|大眼的度|些[微少許小]|[淹沉浸覆湮埋沒出]沒|沒[落頂收]|神出鬼沒|了[結無斷當然哥結得解事之]|[未明]了|不得了|大不了|他[信人國日殺鄉]|[其利無排維結]他|馬耳他|他加祿|他山之石|其[它]|[收查窺觀]看|看[守住好護]|刮目相看|[酒網水貼]吧|吧[務台臺枱檯]|[退忘阻]卻|卻步|[遊游小傳解學假淺眾衆訴論][説說]|[說説][話服明]|自圓其[説說]|長話短[說説]|不由分[說説]|吃[虧苦力醋]|口吃|弄[堂]|[賣擺嘲]弄|可[怒惱]也|如也|也門|之乎者也|天助我也/gu

/** Four-way label, matching upstream's LanguageType. */
export type ChineseVariant = 'cantonese' | 'mandarin' | 'mixed' | 'neutral'

/** Upstream matches the cheap char class first, words only as fallback. */
function hasCantoUnique(s: string): boolean {
  return CANTO_UNIQUE_CHAR.test(s) || CANTO_UNIQUE_WORD.test(s)
}

function spans(re: RegExp, s: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of s.matchAll(re)) out.push([m.index, m.index + m[0].length])
  return out
}

/** True when EVERY Mandarin feature sits inside a loanword span. */
function isAllLoan(s: string): boolean {
  const features = spans(MANDO_FEATURE, s)
  const loans = spans(MANDO_LOAN, s)
  return features.every(([fs, fe]) => loans.some(([ls, le]) => fs >= ls && fe <= le))
}

/** Classify a string. Decision tree verbatim from upstream `judge`. */
export function judgeChineseVariant(s: string): ChineseVariant {
  const cantoUnique = hasCantoUnique(s)
  const mandoUnique = MANDO_UNIQUE.test(s)
  const mandoFeature = new RegExp(MANDO_FEATURE.source, 'u').test(s)

  if (cantoUnique) {
    if (!mandoUnique && !mandoFeature) return 'cantonese'
    if (mandoUnique) return 'mixed'
    // Cantonese + Mandarin features: innocent if every feature is a loanword.
    return isAllLoan(s) ? 'cantonese' : 'mixed'
  }
  if (mandoUnique) return 'mandarin'
  if (mandoFeature) return isAllLoan(s) ? 'neutral' : 'mandarin'
  return 'neutral'
}
