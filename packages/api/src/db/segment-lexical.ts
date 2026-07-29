/**
 * `segment-lexical.ts` — the non-vector arm of segment-corpus retrieval.
 *
 * Shared across the segment corpora (`email_archive_segments`,
 * `transcript_segments`, `file_segments`) rather than living in any one
 * store, because they are the same shape and because a future move of one
 * corpus to an external service must not take this with it (B6 —
 * docs/plans/corpus-substrate-hardening.md §6/§7).
 *
 * **Why this exists.** The lexical arm used to bind `%${query}%` and match
 * `segment_text ILIKE $n`: a substring match of the ENTIRE query string. For
 * `what did the supplier say about the delayed shipment` it matched only if
 * those 52 characters appeared verbatim, so it essentially never fired. The
 * vector arm was doing all the work — which meant removing embeddings would
 * delete the feature rather than degrade it, and that is exactly the state the
 * embed budget puts a corpus into on purpose.
 *
 * **Why trigrams and not `tsvector`.** A `tsvector` GIN is the textbook
 * answer and was rejected: the corpora include Chinese enterprise mail,
 * PostgreSQL's default parser does not segment CJK, and `zhparser` / `pg_bigm`
 * are not available on Cloud SQL — so it would serve only the latin half while
 * adding a SECOND text index to tables whose write amplification is already
 * the problem (the embed `UPDATE` writes an indexed column, so it cannot be
 * HOT and rewrites every index entry for the row). The trgm GIN already
 * exists, covers CJK and latin alike, and costs no migration (D8). Revisit
 * only if ranking quality proves insufficient in practice.
 *
 * [COMP:brain/segment-lexical]
 */

/**
 * pg_trgm indexes 3-grams, so a `LIKE '%x%'` pattern shorter than three
 * characters cannot be served by the index and degrades to a scan. Every term
 * this module emits is therefore at least three characters long.
 */
const MIN_TERM_LENGTH = 3

/**
 * Terms per query. Each one costs an `ILIKE` per searched column, so the cap
 * bounds the predicate's width; beyond a handful, extra terms are noise words
 * that add cost without discriminating.
 */
const MAX_TERMS = 8

/**
 * Words carrying no retrieval signal. Deliberately short: an aggressive
 * stoplist is a recall bug in disguise, and the ranking already demotes terms
 * that match everything by matching them everywhere equally.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'were', 'are', 'you', 'your', 'our', 'their',
  'with', 'from', 'that', 'this', 'these', 'those', 'what', 'when', 'where',
  'which', 'who', 'whom', 'how', 'why', 'did', 'does', 'do', 'has', 'have',
  'had', 'about', 'into', 'out', 'any', 'all', 'can', 'could', 'would',
  'should', 'will', 'shall', 'may', 'might', 'been', 'being', 'say', 'said',
  'tell', 'told', 'get', 'got', 'me', 'my', 'we', 'us', 'they', 'them',
])

/** Runs of CJK ideographs / kana / hangul, which carry no word delimiters. */
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/g

/**
 * Split a natural-language query into indexable match terms.
 *
 * Latin text splits on non-word characters. CJK text has no spaces, so a run
 * of ideographs is shingled into overlapping 3-character windows — three
 * because that is what the trigram index can serve; 2-character bigrams, the
 * linguistically natural unit for Chinese, cannot use it.
 *
 * Order is preserved and duplicates removed, so the caller's placeholder
 * numbering is stable.
 */
export function tokenizeSearchTerms(query: string): string[] {
  const text = query.trim()
  if (!text) return []

  const terms: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const term = raw.toLowerCase()
    if (term.length < MIN_TERM_LENGTH) return
    if (STOPWORDS.has(term)) return
    if (seen.has(term)) return
    seen.add(term)
    terms.push(term)
  }

  /**
   * CJK runs too short to shingle — `发票` (invoice) is a whole query, not a
   * fragment. A 2-character pattern cannot use the trigram index, so these are
   * a LAST RESORT only: one unindexed term in an OR forces the whole predicate
   * to scan, which would undo the index for every query that also has usable
   * terms. Used only when nothing else survived, where the choice is a bounded
   * scan versus returning nothing at all.
   */
  const shortCjk: string[] = []

  for (const run of text.match(CJK_RUN) ?? []) {
    if (run.length < MIN_TERM_LENGTH) {
      // A single ideograph is a particle or a fragment — it would match
      // almost every passage, so it discriminates nothing even as a fallback.
      if (run.length < 2) continue
      const term = run.toLowerCase()
      if (!shortCjk.includes(term)) shortCjk.push(term)
      continue
    }
    for (let i = 0; i + MIN_TERM_LENGTH <= run.length; i++) {
      push(run.slice(i, i + MIN_TERM_LENGTH))
    }
  }

  for (const word of text.replace(CJK_RUN, ' ').split(/[^\p{L}\p{N}_@.'-]+/u)) {
    // Trailing punctuation survives the class above (`clause.` / `4.`), and a
    // bare `.`-only fragment is not a term.
    push(word.replace(/^[.'-]+|[.'-]+$/g, ''))
  }

  if (terms.length === 0) return shortCjk.slice(0, MAX_TERMS)
  return terms.slice(0, MAX_TERMS)
}

export type LexicalMatch = {
  /** SQL boolean — true when at least one term hit at least one column. */
  where: string
  /** SQL integer — how many DISTINCT terms hit, the primary rank key. */
  hits: string
}

/**
 * Build the term-match predicate and its hit-count ranking expression.
 *
 * Pushes one `%term%` parameter per term onto `values` (shared with the
 * caller's other bindings, so placeholder numbers stay correct) and matches it
 * against every column in `columns`.
 *
 * Returns null when the query yields no usable terms — the caller should then
 * skip the lexical arm entirely rather than run a predicate that matches
 * everything.
 */
export function buildLexicalMatch(opts: {
  terms: string[]
  /** Qualified column expressions, e.g. `['es.segment_text', 'm.subject']`. */
  columns: string[]
  /** Bound parameters, appended to in place. */
  values: unknown[]
}): LexicalMatch | null {
  if (opts.terms.length === 0 || opts.columns.length === 0) return null

  const perTerm = opts.terms.map((term) => {
    opts.values.push(`%${term}%`)
    const idx = opts.values.length
    return `(${opts.columns.map((col) => `${col} ILIKE $${idx}`).join(' OR ')})`
  })

  return {
    where: `(${perTerm.join(' OR ')})`,
    // A term either hit or it didn't — count terms, not occurrences, so a
    // passage repeating one word cannot outrank one covering the whole query.
    hits: perTerm.map((clause) => `(CASE WHEN ${clause} THEN 1 ELSE 0 END)`).join(' + '),
  }
}

/** Reciprocal-rank-fusion constant. 60 is the value from the original RRF
 *  paper and the one every implementation defaults to; it damps the top of
 *  each list so a single arm's first result cannot dominate the fusion. */
const RRF_K = 60

/**
 * Fuse ranked arms by reciprocal rank.
 *
 * Each arm contributes `1 / (k + position)` to a document's score, so a
 * passage found by BOTH arms outranks one found strongly by either alone —
 * which is the property that keeps results useful when the vector arm covers
 * only a fraction of the corpus. Scores are comparable across arms without
 * needing to normalize a cosine distance against a term count.
 *
 * `keyOf` identifies the same document across arms. Ties resolve by the order
 * arms were passed in.
 */
export function fuseByReciprocalRank<T>(
  arms: T[][],
  keyOf: (item: T) => string,
): T[] {
  const scored = new Map<string, { item: T; score: number }>()
  for (const arm of arms) {
    arm.forEach((item, position) => {
      const key = keyOf(item)
      const contribution = 1 / (RRF_K + position + 1)
      const existing = scored.get(key)
      if (existing) existing.score += contribution
      else scored.set(key, { item, score: contribution })
    })
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}
