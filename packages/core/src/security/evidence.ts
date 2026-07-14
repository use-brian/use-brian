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
  }

  /**
   * Feed a SUCCESSFUL tool result. Identifiers that also appear in the
   * tool's own input are excluded — they are model-authored, merely echoed
   * back (search-query echo, fetched-URL echo), and echoing is not
   * verification. Callers must not feed error results at all: an error can
   * only echo the input or describe the failure.
   */
  noteToolResult(contentText: string | null | undefined, inputText: string): void {
    if (!contentText) return
    const found = extractAll(contentText)
    const echoed = extractAll(inputText)
    for (const e of found.emails) if (!echoed.emails.has(e)) this.#evidence.emails.add(e)
    for (const u of found.urls) if (!echoed.urls.has(u)) this.#evidence.urls.add(u)
    for (const u of found.urlsNoQuery)
      if (!echoed.urlsNoQuery.has(u)) this.#evidence.urlsNoQuery.add(u)
    for (const h of found.handles) if (!echoed.handles.has(h)) this.#evidence.handles.add(h)
    for (const p of found.phones) if (!echoed.phones.has(p)) this.#evidence.phones.add(p)
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
