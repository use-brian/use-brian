/**
 * Identifier-evidence accumulator — the mechanical half of the workflow
 * anti-fabrication guard (fix C's hard enforcement).
 *
 * Problem: an unattended callee (workflow step, scheduled job) under budget
 * pressure fills required output fields with plausible-but-invented contact
 * identifiers — emails, profile URLs, handles, phone numbers — which a write
 * tool then persists as records and a later workflow consumes (the
 * 2026-07-13 fls.com.hk HKTVmall prospect incident: fabricated emails / IG
 * handles / LinkedIn URLs saved via saveContact / saveCompany /
 * saveBlueprintRecord, feeding a cold-mail workflow). The prompt guard
 * (`workflowGuardBlock` in packages/api/src/inter-assistant/executor.ts)
 * instructs the model not to do this; this module makes the record-write
 * boundary refuse it mechanically.
 *
 * Model: mirrors `SensitivityAccumulator` — a per-run object threaded on
 * `ToolContext`. The tool executor `note()`s every tool result's content
 * (exactly the capped text the model itself saw); the run's owner seeds it
 * with caller-provided material (step instruction, caller context) since an
 * identifier the caller supplied is legitimate input, not fabrication.
 * Before a gated write tool executes, the executor scans the validated
 * input for identifier-shaped values and rejects the call when one was
 * never observed this run — with an error the model can act on (re-verify
 * with a tool, or drop the field / mark it "not verified").
 *
 * Extraction is deliberately ASYMMETRIC:
 *   - evidence side (`note`): generous — over-collecting evidence only ever
 *     lets more writes through.
 *   - candidate side (`findUnverified`): conservative — a value is flagged
 *     only when it is confidently an identifier (an email; a URL with a
 *     scheme, `www.`, a path, or a common TLD; an `@handle`; a phone with
 *     `+` or internal separators). Ambiguous tokens (bare digit runs,
 *     `foo.md`-style filenames) are never flagged, so the gate cannot
 *     false-block prose, dates, or ids. Person names and street addresses
 *     are NOT mechanically gateable (no reliable shape) — those stay on the
 *     prompt guard.
 *
 * Known non-goal: this is not adversarial-proof (a model could in principle
 * launder a guess through a search query whose result echoes it). It targets
 * the observed non-adversarial failure — honest gap-filling under budget
 * pressure. See docs/architecture/engine/identifier-provenance-gate.md.
 */

export type IdentifierKind = 'email' | 'url' | 'handle' | 'phone'

export type UnverifiedIdentifier = {
  kind: IdentifierKind
  /** The raw value as it appeared in the write input (for the error copy). */
  value: string
}

// ── Extraction ─────────────────────────────────────────────────

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/** Scheme'd or www URLs — always identifier-shaped, on both sides. */
const SCHEMED_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`\\|(){}\[\],;]+/gi

/**
 * Bare domains (optionally with a path), e.g. `instagram.com/slowood`,
 * `fls.com.hk`. Candidate-side these only count with a path or a common
 * TLD (see COMMON_TLDS) so `component-map.md` / `executor.ts` style tokens
 * are never flagged.
 */
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"'`\\|(){}\[\],;]*)?/gi

/**
 * TLDs common enough that a bare `name.tld` token (no scheme, no path) is
 * confidently a web address rather than a filename or code reference.
 * Deliberately short — extending it only widens what the gate can flag.
 */
const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'ai', 'app', 'dev', 'me', 'info', 'biz',
  'shop', 'store', 'online', 'site', 'xyz', 'hk', 'uk', 'cn', 'jp', 'tw',
  'sg', 'au', 'ca', 'de', 'fr', 'in', 'us', 'edu', 'gov',
])

/** `@handle` mentions. Lookbehind keeps emails and mid-word `@`s out. */
const HANDLE_RE = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)/g

/** Social hosts whose first path segment is an account handle. */
const SOCIAL_HOSTS = new Set([
  'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'facebook.com',
  'threads.net', 'youtube.com', 'linkedin.com', 'github.com', 'medium.com',
  'pinterest.com', 'telegram.me', 't.me',
])

/**
 * Evidence-side phone extraction: any run of 7-15 digits, separators
 * allowed. Candidate-side (CANDIDATE_PHONE_RE) is stricter: a `+` prefix or
 * internal separators required, so bare numbers / dates / ids never flag.
 */
const EVIDENCE_PHONE_RE = /\+?\d(?:[\d\s().-]{5,17})\d/g
const CANDIDATE_PHONE_RE = /(?:\+\d[\d\s().-]{6,17}\d)|(?:\d{2,4}(?:[\s.-]\d{2,4}){2,4})/g

/** Date-shaped digit groups (2026-07-14, 14.07.2026) — never phone candidates. */
const DATE_SHAPE_RE =
  /^(?:19|20)\d{2}[\s.-]\d{1,2}[\s.-]\d{1,2}$|^\d{1,2}[\s.-]\d{1,2}[\s.-](?:19|20)\d{2}$/

// ── Normalization ──────────────────────────────────────────────

function normalizeEmail(raw: string): string {
  return raw.toLowerCase().replace(/[.,;:]+$/, '')
}

function normalizeUrl(raw: string): string {
  let u = raw.toLowerCase().trim()
  u = u.replace(/^https?:\/\//, '')
  u = u.replace(/^www\./, '')
  u = u.replace(/#[^]*$/, '')
  u = u.replace(/[.,;:!?'")\]]+$/, '')
  u = u.replace(/\/+$/, '')
  return u
}

/** Host+path variant with the query string dropped (match fallback). */
function urlWithoutQuery(normalized: string): string {
  const q = normalized.indexOf('?')
  return q === -1 ? normalized : normalized.slice(0, q)
}

function normalizeHandle(raw: string): string {
  return raw.toLowerCase().replace(/^@/, '').replace(/[.]+$/, '')
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

function extractHandleFromUrl(normalizedUrl: string): string | null {
  const slash = normalizedUrl.indexOf('/')
  if (slash === -1) return null
  const host = normalizedUrl.slice(0, slash)
  if (!SOCIAL_HOSTS.has(host)) return null
  const segments = normalizedUrl.slice(slash + 1).split('/')
  // linkedin.com/in/<slug>, youtube.com/@<name> — take the account segment.
  let seg = segments[0] ?? ''
  if ((seg === 'in' || seg === 'company') && segments[1]) seg = segments[1]
  seg = normalizeHandle(seg)
  return seg.length >= 2 ? seg : null
}

function looksLikeCandidateUrl(raw: string): boolean {
  if (/^https?:\/\//i.test(raw) || /^www\./i.test(raw)) return true
  const normalized = normalizeUrl(raw)
  if (normalized.includes('/')) return true
  const labels = normalized.split('.')
  const tld = labels[labels.length - 1] ?? ''
  return COMMON_TLDS.has(tld)
}

// ── Figures (grounding gate v2) ────────────────────────────────
//
// Canonicalized numeric / date evidence for the reply-boundary claims
// check (docs/architecture/engine/grounding-gate.md). Same asymmetry as
// identifiers: the evidence side collects every number-ish token
// generously; the claim side (`extractFigureClaims`) only flags
// confidently-figure-shaped values (currency, number+unit, CJK magnitude
// compounds, thousands-separated numbers, percentages, explicit dates) so
// prose like "the offer has 3 parts" can never be flagged.

export type ClaimKind = 'amount' | 'percent' | 'date'

export type FigureClaim = {
  kind: ClaimKind
  /** The value as it appeared (normalized width) — for nudge/trailer copy. */
  claim: string
  /** Canonical key, e.g. `n:40000`, `p:4.5`, `d:7-23`. */
  canonical: string
}

/** Which tool result backed a figure — `null` means seeded caller/user material. */
export type FigureSource = { toolUseId: string; toolName: string }

const FULLWIDTH_CHARS = /[０-９，．％]/g
const FULLWIDTH_MAP: Record<string, string> = {
  '，': ',', '．': '.', '％': '%',
}

function toHalfWidth(text: string): string {
  return text.replace(FULLWIDTH_CHARS, (ch) =>
    FULLWIDTH_MAP[ch] ?? String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

const CJK_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CJK_SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
const CJK_BIG_UNITS: Record<string, number> = { 萬: 1e4, 万: 1e4, 億: 1e8, 亿: 1e8 }

/** Parse a pure CJK numeral run (十一萬, 四萬五千). Null on anything else. */
function cjkNumeralValue(run: string): number | null {
  let total = 0
  let section = 0
  let digit = 0
  for (const ch of run) {
    if (ch in CJK_DIGITS) {
      digit = CJK_DIGITS[ch]!
    } else if (ch in CJK_SMALL_UNITS) {
      section += (digit || 1) * CJK_SMALL_UNITS[ch]!
      digit = 0
    } else if (ch in CJK_BIG_UNITS) {
      section += digit
      total += (section || 1) * CJK_BIG_UNITS[ch]!
      section = 0
      digit = 0
    } else {
      return null
    }
  }
  const value = total + section + digit
  return Number.isFinite(value) && value > 0 ? value : null
}

function numberKey(value: number): string {
  return `n:${value}`
}

/** Arabic numbers, optionally thousands-separated / decimal. */
const ARABIC_NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g
/** Arabic value + CJK magnitude (4萬, 36.4萬). */
const MIXED_MAGNITUDE_RE = /(\d+(?:\.\d+)?)\s*([萬万億亿])/g
/** Pure CJK numeral run of 2+ chars (skips a lone 一 in prose). */
const CJK_NUMERAL_RUN_RE = /[零一二兩两三四五六七八九十百千萬万億亿]{2,}/g
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/g
/** Explicit dates: 7月23日 / 2026年7月23日, ISO 2026-07-23, "July 23". */
const CJK_DATE_RE = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]/g
const ISO_DATE_RE = /(?:\d{4})-(\d{1,2})-(\d{1,2})\b/g
const MONTH_NAME_DATE_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function dateKey(month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `d:${month}-${day}`
}

/**
 * Evidence-side extraction — generous: every number-ish token, expanded
 * magnitudes, percentages, and explicit dates, as canonical keys.
 */
export function extractFigureKeys(rawText: string): Set<string> {
  const keys = new Set<string>()
  const text = toHalfWidth(rawText)
  for (const m of text.match(ARABIC_NUMBER_RE) ?? []) {
    const value = Number(m.replace(/,/g, ''))
    if (Number.isFinite(value)) keys.add(numberKey(value))
  }
  for (const m of text.matchAll(MIXED_MAGNITUDE_RE)) {
    const value = Number(m[1]) * CJK_BIG_UNITS[m[2]!]!
    if (Number.isFinite(value)) keys.add(numberKey(value))
  }
  for (const m of text.match(CJK_NUMERAL_RUN_RE) ?? []) {
    const value = cjkNumeralValue(m)
    if (value !== null) keys.add(numberKey(value))
  }
  for (const m of text.matchAll(PERCENT_RE)) keys.add(`p:${Number(m[1])}`)
  for (const m of text.matchAll(CJK_DATE_RE)) {
    const key = dateKey(Number(m[2]), Number(m[3]))
    if (key) keys.add(key)
  }
  for (const m of text.matchAll(ISO_DATE_RE)) {
    const key = dateKey(Number(m[1]), Number(m[2]))
    if (key) keys.add(key)
  }
  for (const m of text.matchAll(MONTH_NAME_DATE_RE)) {
    const key = dateKey(MONTH_INDEX[m[1]!.toLowerCase()]!, Number(m[2]))
    if (key) keys.add(key)
  }
  return keys
}

/** Currency-marked amounts, either side of the number. */
const CURRENCY_PREFIX_RE = /(?:HK\$|NT\$|US\$|R?MB|\$|¥|€|£)\s?(\d[\d,]*(?:\.\d+)?)/g
const CURRENCY_SUFFIX_RE =
  /(\d[\d,]*(?:\.\d+)?)\s?(?:蚊|港幣|港元|美元|人民幣|人民币|日圓|日元|dollars?|HKD|USD|RMB|CNY|JPY|元|円)/g
/** Number + volatile unit (miles, points, 里數…). */
const UNIT_AMOUNT_RE =
  /(\d[\d,]*(?:\.\d+)?)\s?(?:里數|里数|里|miles?|points?|pts|積分|积分|credits?)/g
/** Thousands-separated numbers are figure claims even without a unit. */
const SEPARATED_NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/g
/** CJK-magnitude amounts: 4萬 / 36.4萬 / 十一萬 / 四萬五千. */
const CJK_AMOUNT_RE =
  /\d+(?:\.\d+)?\s*[萬万億亿]|[一二兩两三四五六七八九十百千]+[萬万億亿][零一二兩两三四五六七八九十百千]*/g

/**
 * Claim-side extraction — conservative: only confidently-figure-shaped
 * values are claims. Bare unseparated integers never are. Deduplicated by
 * canonical key.
 */
export function extractFigureClaims(rawText: string): FigureClaim[] {
  const text = toHalfWidth(rawText)
  const out: FigureClaim[] = []
  const seen = new Set<string>()
  const push = (kind: ClaimKind, claim: string, canonical: string | null) => {
    if (!canonical || seen.has(canonical)) return
    seen.add(canonical)
    out.push({ kind, claim: claim.trim(), canonical })
  }
  const amountFromArabic = (raw: string): string | null => {
    const value = Number(raw.replace(/,/g, ''))
    return Number.isFinite(value) ? numberKey(value) : null
  }
  for (const m of text.matchAll(CURRENCY_PREFIX_RE)) push('amount', m[0], amountFromArabic(m[1]!))
  for (const m of text.matchAll(CURRENCY_SUFFIX_RE)) push('amount', m[0], amountFromArabic(m[1]!))
  for (const m of text.matchAll(UNIT_AMOUNT_RE)) push('amount', m[0], amountFromArabic(m[1]!))
  for (const m of text.match(CJK_AMOUNT_RE) ?? []) {
    const mixed = /^(\d+(?:\.\d+)?)\s*([萬万億亿])$/.exec(m)
    const value = mixed ? Number(mixed[1]) * CJK_BIG_UNITS[mixed[2]!]! : cjkNumeralValue(m)
    push('amount', m, value !== null && Number.isFinite(value) ? numberKey(value) : null)
  }
  for (const m of text.match(SEPARATED_NUMBER_RE) ?? []) push('amount', m, amountFromArabic(m))
  for (const m of text.matchAll(PERCENT_RE)) push('percent', m[0], `p:${Number(m[1])}`)
  for (const m of text.matchAll(CJK_DATE_RE)) push('date', m[0], dateKey(Number(m[2]), Number(m[3])))
  for (const m of text.matchAll(ISO_DATE_RE)) push('date', m[0], dateKey(Number(m[1]), Number(m[2])))
  for (const m of text.matchAll(MONTH_NAME_DATE_RE)) {
    push('date', m[0], dateKey(MONTH_INDEX[m[1]!.toLowerCase()]!, Number(m[2])))
  }
  return out
}

// ── Accumulator ────────────────────────────────────────────────

type IdentifierSets = {
  emails: Set<string>
  urls: Set<string>
  urlsNoQuery: Set<string>
  handles: Set<string>
  phones: Set<string>
}

function emptySets(): IdentifierSets {
  return {
    emails: new Set(),
    urls: new Set(),
    urlsNoQuery: new Set(),
    handles: new Set(),
    phones: new Set(),
  }
}

/** Extract every identifier (generously) from `text` into fresh sets. */
function extractAll(text: string): IdentifierSets {
  const sets = emptySets()
  for (const m of text.match(EMAIL_RE) ?? []) sets.emails.add(normalizeEmail(m))
  const urlMatches = [
    ...(text.match(SCHEMED_URL_RE) ?? []),
    ...(text.match(BARE_DOMAIN_RE) ?? []),
  ]
  for (const m of urlMatches) {
    const normalized = normalizeUrl(m)
    if (!normalized) continue
    sets.urls.add(normalized)
    sets.urlsNoQuery.add(urlWithoutQuery(normalized))
    const handle = extractHandleFromUrl(normalized)
    if (handle) sets.handles.add(handle)
  }
  for (const m of text.matchAll(HANDLE_RE)) sets.handles.add(normalizeHandle(m[1]!))
  for (const m of text.match(EVIDENCE_PHONE_RE) ?? []) {
    const digits = normalizePhone(m)
    if (digits.length >= 7 && digits.length <= 15) sets.phones.add(digits)
  }
  return sets
}

export type EvidenceAccumulatorOptions = {
  /**
   * Tool names whose (validated) input must pass `findUnverified` before
   * executing. Empty/absent = accumulate only, gate nothing.
   */
  gatedTools?: Iterable<string>
}

/**
 * Per-run identifier-evidence sets. Seed with `note()` for caller-provided
 * material; feed tool results through `noteToolResult()` (which excludes
 * identifiers the model itself put into the tool's input — a webSearch
 * result echoes its `query`, so without the exclusion a model could
 * "verify" an invented email just by searching for it); consult
 * `findUnverified()` on a gated write's input before executing it.
 *
 * There is deliberately NO raw-text substring fallback: a corpus that
 * contains echoed inputs is launderable, and sets keep matching exact and
 * auditable. The cost is that an identifier the evidence renders in an
 * exotic format ("vicky (at) slowood.hk") won't match its normalized form —
 * the gate then errs toward "not verified", which is the safe direction.
 */
export class EvidenceAccumulator {
  #evidence: IdentifierSets = emptySets()
  #gatedTools: Set<string>
  /**
   * Canonical figure key → the tool result that first observed it, or
   * `null` when it came from seeded caller/user material. First-seen wins
   * so a figure keeps its original provenance.
   */
  #figures = new Map<string, FigureSource | null>()

  constructor(options?: EvidenceAccumulatorOptions) {
    this.#gatedTools = new Set(options?.gatedTools ?? [])
  }

  shouldGate(toolName: string): boolean {
    return this.#gatedTools.has(toolName)
  }

  /** Seed with caller-provided material (instruction, context). Everything
   *  in it counts as observed — the caller said it, the model didn't. */
  note(text: string | null | undefined): void {
    if (!text) return
    const found = extractAll(text)
    for (const e of found.emails) this.#evidence.emails.add(e)
    for (const u of found.urls) this.#evidence.urls.add(u)
    for (const u of found.urlsNoQuery) this.#evidence.urlsNoQuery.add(u)
    for (const h of found.handles) this.#evidence.handles.add(h)
    for (const p of found.phones) this.#evidence.phones.add(p)
    for (const k of extractFigureKeys(text)) {
      if (!this.#figures.has(k)) this.#figures.set(k, null)
    }
  }

  /**
   * Feed a SUCCESSFUL tool result. Identifiers that also appear in the
   * tool's own input are excluded — they are model-authored, merely echoed
   * back (search-query echo, fetched-URL echo), and echoing is not
   * verification. Callers must not feed error results at all: an error can
   * only echo the input or describe the failure.
   *
   * `source` attributes figures observed in this result for the claim
   * ledger (grounding gate v2). Figures follow the same echo exclusion:
   * searching for an invented figure cannot verify it — the honest
   * verification path is to search the topic, not the number.
   */
  noteToolResult(
    contentText: string | null | undefined,
    inputText: string,
    source?: FigureSource,
  ): void {
    if (!contentText) return
    const found = extractAll(contentText)
    const echoed = extractAll(inputText)
    for (const e of found.emails) if (!echoed.emails.has(e)) this.#evidence.emails.add(e)
    for (const u of found.urls) if (!echoed.urls.has(u)) this.#evidence.urls.add(u)
    for (const u of found.urlsNoQuery)
      if (!echoed.urlsNoQuery.has(u)) this.#evidence.urlsNoQuery.add(u)
    for (const h of found.handles) if (!echoed.handles.has(h)) this.#evidence.handles.add(h)
    for (const p of found.phones) if (!echoed.phones.has(p)) this.#evidence.phones.add(p)
    const echoedFigures = extractFigureKeys(inputText)
    for (const k of extractFigureKeys(contentText)) {
      if (echoedFigures.has(k)) continue
      if (!this.#figures.has(k)) this.#figures.set(k, source ?? null)
    }
  }

  /** Was this canonical figure observed this run (tool result or seed)? */
  hasFigure(canonical: string): boolean {
    return this.#figures.has(canonical)
  }

  /** Which tool result backed the figure — `null` = seeded material,
   *  `undefined` = never observed. */
  figureSource(canonical: string): FigureSource | null | undefined {
    return this.#figures.get(canonical)
  }

  #hasEmail(candidate: string): boolean {
    return this.#evidence.emails.has(normalizeEmail(candidate))
  }

  #hasUrl(candidate: string): boolean {
    const normalized = normalizeUrl(candidate)
    if (this.#evidence.urls.has(normalized)) return true
    if (this.#evidence.urlsNoQuery.has(urlWithoutQuery(normalized))) return true
    // A social-profile URL is verified if its handle was observed (e.g. the
    // page showed "@slowood" and the model wrote instagram.com/slowood).
    const handle = extractHandleFromUrl(normalized)
    if (handle && this.#evidence.handles.has(handle)) return true
    return false
  }

  #hasHandle(candidate: string): boolean {
    return this.#evidence.handles.has(normalizeHandle(candidate))
  }

  #hasPhone(candidate: string): boolean {
    const digits = normalizePhone(candidate)
    if (digits.length < 7) return true // too short to judge — never flag
    if (this.#evidence.phones.has(digits)) return true
    for (const seen of this.#evidence.phones) {
      if (seen.endsWith(digits) || digits.endsWith(seen)) return true
    }
    return false
  }

  /**
   * Scan `text` (typically `JSON.stringify` of a write tool's validated
   * input) for identifier-shaped values never observed this run. Returns
   * the offenders, deduplicated; empty array = the write is clean.
   */
  findUnverified(text: string): UnverifiedIdentifier[] {
    const out: UnverifiedIdentifier[] = []
    const flagged = new Set<string>()
    const flag = (kind: IdentifierKind, value: string) => {
      const key = `${kind}:${value.toLowerCase()}`
      if (flagged.has(key)) return
      flagged.add(key)
      out.push({ kind, value })
    }

    const emails = new Set(text.match(EMAIL_RE) ?? [])
    for (const m of emails) {
      if (!this.#hasEmail(m)) flag('email', m)
    }
    const urlMatches = [
      ...(text.match(SCHEMED_URL_RE) ?? []),
      ...(text.match(BARE_DOMAIN_RE) ?? []),
    ]
    // Dedup by normalized form — the bare-domain regex re-matches the
    // host+path inside every schemed match.
    const seenUrlCandidates = new Set<string>()
    for (const m of urlMatches) {
      // Skip the domain tail of an email the email pass already judged.
      if ([...emails].some((e) => e.includes(m))) continue
      if (!looksLikeCandidateUrl(m)) continue
      const normalized = normalizeUrl(m)
      if (seenUrlCandidates.has(normalized)) continue
      seenUrlCandidates.add(normalized)
      if (!this.#hasUrl(m)) flag('url', m)
    }
    for (const m of text.matchAll(HANDLE_RE)) {
      if (!this.#hasHandle(m[1]!)) flag('handle', `@${m[1]!}`)
    }
    for (const m of text.match(CANDIDATE_PHONE_RE) ?? []) {
      const trimmed = m.trim()
      if (DATE_SHAPE_RE.test(trimmed)) continue
      const digits = normalizePhone(trimmed)
      if (digits.length < 7 || digits.length > 15) continue
      if (!this.#hasPhone(trimmed)) flag('phone', trimmed)
    }
    return out
  }
}
