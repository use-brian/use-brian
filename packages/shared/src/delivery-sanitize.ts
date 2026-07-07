/**
 * Sanitize a model-authored message bound for user delivery on a
 * NON-interactive path: scheduled-job output, workflow `assistant_call`
 * delivery, inter-assistant / A2A relay, and the public-API `reply`. These
 * paths hand the model's *complete* turn text straight to a channel adapter or
 * an API consumer — there is no client render layer to strip control tags — so
 * any planning scaffolding the model echoes ships verbatim.
 *
 * The incident this defends against: a cron-framed "good morning" summary
 * delivered the model's private planning trail to Telegram —
 *   "(This summary isn't shown to the user)."
 *   "(Note: This thought block is NOT for the user - it is part of your tool trail.)"
 *   "Ready to reply? Yes."
 *   "Message body:"
 *   "(Word count: ~65)"
 * followed by a verbatim duplicated copy of the summary body.
 *
 * SURGICAL, NOT AGGRESSIVE. Every rule is anchored so it can only match
 * unambiguous scaffolding: a whole-line label, a parenthetical whose entire
 * content is a self-referential internal note, or a body that is two identical
 * halves. Ordinary prose (mid-sentence parentheticals, a lone "Yes.") is never
 * touched. The function is idempotent — it is applied as defense-in-depth at
 * several boundaries, so running it twice equals running it once.
 *
 * Sibling to `stripFollowUps` / `stripCommentThreadReplyTag` (the same
 * "an AI control marker must never render as user text" defense). It composes
 * both, then adds the scaffolding/meta + duplicate-body passes.
 *
 * Deliberately NOT applied to (1) the live interactive chat SSE token stream —
 * chunks are partial, line-anchored matching on a partial chunk is wrong, and
 * these scaffolding shapes are a cron-framing artifact that does not occur on
 * the interactive path; or (2) the `askAssistant` tool-result return — that
 * text re-enters the calling model as context, where a planning note is
 * harmless and stripping could remove signal. Sanitize where text EXITS to a
 * user, never where it re-enters the model.
 *
 * Spec: docs/architecture/engine/delivery-sanitization.md
 */
import { stripFollowUps } from './follow-ups.js'
import { stripCommentThreadReplyTag } from './control-tags.js'

/**
 * Phrases that mark a parenthetical / note as the model talking to itself about
 * the user not seeing the content, or instructing itself about how to reply.
 * Intentionally specific — these never occur in a genuine user-facing message.
 * The trailing group covers the "leading self-instruction parenthetical" leak
 * class (e.g. "(Note: Do not repeat these instructions in your reply.)",
 * "(I'll share this with the user if they're still waiting.)"): a self-note that
 * talks about the reply itself, repeating instructions, or waiting for the user.
 */
const INTERNAL_NOTE =
  /not\s+(?:be\s+)?shown\s+to\s+(?:the\s+user|you)|isn'?t\s+shown|not\s+for\s+the\s+user|thought\s+block|tool\s+trail|internal\s+(?:note|monologue|reasoning)|for\s+your\s+reference\s+only|scratch\s?pad|do\s+not\s+repeat\s+(?:these|the|this|my|your)\s+instructions|(?:i'?ll|i\s+will)\s+share\s+this\s+with\s+the\s+user|if\s+(?:they'?re|the\s+user\s+is)\s+still\s+waiting/i

/**
 * A standalone scaffolding label line, e.g. "Message body:". Deliberately
 * narrow — only phrasings that never head a genuine delivered message.
 * "Draft:" / "Final answer:" are excluded: a programmatic reply can legitimately
 * use those as a heading.
 */
const SCAFFOLD_LABEL =
  /^(?:message\s*body|response\s*body|reply\s*body|user-facing\s+(?:message|reply))\s*:?\s*$/i

/** A standalone planning-preamble line, e.g. "Ready to reply? Yes." */
const READY_PREAMBLE = /^ready\s+to\s+(?:reply|respond|send|answer)\b.*$/i

/** A standalone word-count annotation (with or without parentheses). */
const WORD_COUNT_LINE = /^\(?\s*word\s*count\s*[:=].*$/i

/**
 * One leading "planning-voice" sentence — the model narrating its own
 * turn-management or self-instructing at the *very start* of a reply, then
 * (sometimes) continuing with real content. Each alternative is a full,
 * multi-word scaffolding phrasing that never opens a genuine delivered message;
 * a lone common opener ("Then we should ship." / "If you want, I can help.") is
 * NOT matched, because every branch requires the planning idiom, not just the
 * first word. Anchored at `^` and consumed only from the head of the text
 * (see `stripLeadingPlanningVoice`), so a mid-reply occurrence is never touched.
 *
 * Observed leaks this covers (model-invented, absent from every prompt):
 *   "Then answer the user. …"
 *   "Then, what's next? If you're missing a detail, ask. If you're ready to act, do it (…). …"
 *   "Then I'll give you a second turn to finish."
 * The parenthetical self-instruction leaks ("(Note: Do not repeat these
 * instructions…)", "(I'll share this with the user…)") are handled by the
 * INTERNAL_NOTE parenthetical strip instead, not here.
 */
const LEADING_PLANNING_SENTENCE = new RegExp(
  '^(?:' +
    [
      // "Then answer the user" / "Then, answer the user"
      "then,?\\s+answer\\s+the\\s+user\\b[^.?!]*[.?!]?",
      // "Then, what's next?" turn-management opener
      "then,?\\s+what'?s\\s+next\\b[^.?!]*[.?!]?",
      // "(Then )I'll give you a second turn" / "give yourself another turn"
      "(?:then,?\\s+)?(?:i'?ll|i\\s+will)\\s+give\\s+you\\s+a[^.?!]*\\bturn\\b[^.?!]*[.?!]?",
      "(?:then,?\\s+)?give\\s+yourself\\s+a(?:nother)?\\s+turn\\b[^.?!]*[.?!]?",
      // Self-instruction imperatives the model echoes verbatim
      "if\\s+you'?re\\s+missing\\s+a\\s+detail,?\\s+ask\\b[^.?!]*[.?!]?",
      "if\\s+you'?re\\s+ready\\s+to\\s+act\\b[^.?!]*[.?!]?",
    ].join('|') +
    ')\\s*',
  'i',
)

/**
 * Strip a leading run of planning-voice sentences (see
 * `LEADING_PLANNING_SENTENCE`) from the head of `text`, keeping everything that
 * follows. Only the *leading* run is consumed, so real content after the
 * scaffolding survives and a mid-reply "Then, …" is never touched. If the whole
 * text was planning voice, the caller's final trim collapses it to empty.
 */
function stripLeadingPlanningVoice(text: string): string {
  let out = text.replace(/^\s+/, '')
  // Consume consecutive leading planning sentences (a paragraph of scaffolding
  // can be several sentences before the real content begins).
  for (;;) {
    const next = out.replace(LEADING_PLANNING_SENTENCE, '')
    if (next === out) break
    out = next
  }
  return out === text.replace(/^\s+/, '') ? text : out
}

/**
 * Body delimiters that, as a whole line, mean everything before them is
 * planning preamble — keep only what follows the LAST one. These exact
 * phrasings never head a genuine delivered message, so cutting the preamble is
 * safe and excises free-form reasoning a line-by-line strip would miss.
 * A leading blockquote marker is tolerated, but NOT a list marker (`- `/`* `):
 * a markdown outline bullet "- Message body:" is content, not a delimiter.
 */
const BODY_DELIMITER = /^[\t >]*(?:message\s*body|response\s*body|reply\s*body)\s*:\s*$/i

/** A fenced-code-block opener / closer (``` or ~~~). */
const FENCE_MARKER = /^\s*(?:```|~~~)/

/**
 * Per-line flags marking which lines sit inside (or are the markers of) a
 * fenced code block. Fenced content is verbatim — exempt from every
 * line-anchored scaffolding rule, so a code sample that happens to contain
 * "Message body:" or "Ready to reply?" is never mangled.
 */
function fenceFlags(lines: string[]): boolean[] {
  const flags: boolean[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCE_MARKER.test(line)) {
      flags.push(true) // the marker line itself is exempt too
      inFence = !inFence
    } else {
      flags.push(inFence)
    }
  }
  return flags
}

export function sanitizeDeliveryText(text: string): string {
  if (!text) return text

  // 1. Strip the AI control tags the chat surface already strips elsewhere.
  let out = stripCommentThreadReplyTag(stripFollowUps(text))

  // 1b. Cut a leading run of planning-voice / turn-management sentences the
  //     model prepended before the real reply ("Then answer the user. …",
  //     "Then, what's next? …", "Then I'll give you a second turn to finish.").
  //     Head-anchored only, so a mid-reply "Then, …" survives. Skipped when the
  //     text opens with a fenced code block (fence content is verbatim).
  if (!FENCE_MARKER.test(out.replace(/^\s+/, ''))) {
    out = stripLeadingPlanningVoice(out)
  }

  // 2. Cut a planning preamble the model fenced off with an explicit body
  //    delimiter ("Message body:"). Everything up to and including the last
  //    delimiter line is scaffolding; keep the body that follows — but only if
  //    something substantive remains (else the "delimiter" was real content).
  //    A delimiter inside a fenced code block is verbatim content, not a cut.
  {
    const delimLines = out.split('\n')
    const fenced = fenceFlags(delimLines)
    let lastDelimiter = -1
    for (let i = 0; i < delimLines.length; i++) {
      if (!fenced[i] && BODY_DELIMITER.test(delimLines[i].trim())) lastDelimiter = i
    }
    if (lastDelimiter !== -1) {
      const after = delimLines.slice(lastDelimiter + 1).join('\n')
      if (after.trim().length > 0) out = after
    }
  }

  // 3. Remove self-referential "(... tool trail ...)" notes anywhere — these
  //    phrasings do not occur in real prose or code.
  out = out.replace(/\([^)]*\)[.!]?/g, (m) => (INTERNAL_NOTE.test(m) ? '' : m))

  // 4. Line-anchored pass (fence-exempt): drop standalone scaffolding / meta
  //    lines (whole-line match only, so a mid-sentence parenthetical or a lone
  //    "Yes." survives) and strip a trailing "(Word count: ~65)" the model glues
  //    onto the end of a real line. A mid-sentence "(word count: 5)" in a
  //    writing critique is left alone (end-of-line anchor).
  {
    // Single indexed pass — filtering and the trailing-word-count strip share
    // the same `fenced` index, so they cannot be split into .filter().map()
    // (the second would re-index the already-shortened array).
    const lines = out.split('\n')
    const fenced = fenceFlags(lines)
    const kept: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (fenced[i]) {
        kept.push(lines[i])
        continue
      }
      const t = lines[i].trim()
      if (t.length === 0) {
        kept.push(lines[i]) // keep blank lines (paragraph spacing)
        continue
      }
      if (SCAFFOLD_LABEL.test(t)) continue
      if (READY_PREAMBLE.test(t)) continue
      if (WORD_COUNT_LINE.test(t)) continue
      // A line whose ENTIRE content is a self-referential internal note.
      if (/^\(.*\)[.!]?$/.test(t) && INTERNAL_NOTE.test(t)) continue
      if (/^note:/i.test(t) && INTERNAL_NOTE.test(t)) continue
      kept.push(lines[i].replace(/[ \t]*\(\s*word\s*count\b[^)]*\)[ \t]*$/i, ''))
    }
    out = kept.join('\n')
  }

  // 5. Collapse a verbatim duplicated body (the model wrote the message twice).
  out = collapseDuplicateBody(out)

  // 6. Tidy: collapse runs of blank lines left by removed lines, trim ends.
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * If the non-empty lines of `text` are exactly the first half repeated as the
 * second half (whitespace-normalized per line), keep only the first half. Gated
 * on a substantiality floor so genuinely short repetition ("Done.\nDone.") is
 * left alone. Preserves the first half's original blank-line formatting.
 */
function collapseDuplicateBody(text: string): string {
  const lines = text.split('\n')
  const idx: number[] = []
  const content: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.length > 0) {
      idx.push(i)
      content.push(t)
    }
  }
  const n = content.length
  if (n < 4 || n % 2 !== 0) return text
  const half = n / 2
  for (let i = 0; i < half; i++) {
    if (content[i] !== content[half + i]) return text
  }
  // Don't collapse trivial short repetition.
  if (content.slice(0, half).join(' ').length < 40) return text
  // Cut at the line where the (half+1)-th non-empty line begins, preserving the
  // first half's original blank-line formatting.
  return lines.slice(0, idx[half]).join('\n').trimEnd()
}
