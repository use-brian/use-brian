/**
 * Emoji-reaction → feedback classifier.
 *
 * When a user reacts to an assistant message with an emoji on Slack
 * (`reaction_added` event, `:thumbsup:` / `:+1:`) or Telegram
 * (`message_reaction` update, raw emoji string `👍`), this map
 * translates the reaction into the same `{kind, issueType, details}`
 * shape the web feedback modal produces — so all three channels flow
 * through the same `recordFeedback()` writer and land in the same
 * `analytics_events feedback_positive` / `feedback_negative` stream
 * the brain's reflection consolidation reads.
 *
 * Why a curated map (not a sentiment model):
 *  - The reaction surface is intentionally coarse — thumbs and
 *    obvious affect emoji map cleanly; ambiguous ones (🙏, 🤷, 👀)
 *    are NOT classified, returning `null` so the writer skips them.
 *  - We never want to penalise the model for the user reacting with
 *    `:eyes:` to mean "I'll look at this later". Better to miss
 *    signal than fabricate negative feedback the user did not
 *    intend.
 *
 * Slack delivers reactions as text names without colons
 * (`thumbsup`, `+1`, `heart`); the map keys cover both the canonical
 * Slack name and the corresponding unicode emoji. Skin-tone
 * modifiers (`+1::skin-tone-3`, `👍🏽`) are stripped to the base
 * emoji before lookup.
 *
 * Spec: docs/architecture/brain/corrections.md → "Emoji reactions
 * as feedback signal".
 */

/** Map key normaliser — strips skin tone modifiers, leading/trailing
 *  colons, whitespace, and lowercases. The same normaliser must be
 *  applied to both map keys (build-time) and lookup inputs. */
export function normalizeReactionKey(input: string): string {
  if (!input) return ''
  let s = input.trim().toLowerCase()
  // Strip Slack colons
  if (s.startsWith(':') && s.endsWith(':') && s.length > 2) {
    s = s.slice(1, -1)
  }
  // Strip Slack skin-tone modifier (e.g. `+1::skin-tone-3` → `+1`)
  const skinSep = s.indexOf('::skin-tone-')
  if (skinSep >= 0) s = s.slice(0, skinSep)
  // Strip unicode skin-tone modifier (U+1F3FB..U+1F3FF) from emoji
  s = s.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
  // Strip variation selector (U+FE0F) emitted on some platforms
  s = s.replace(/️/g, '')
  return s
}

export type ReactionClassification = {
  kind: 'positive' | 'negative'
  /** Stable label that lands on the analytics row's `metadata.details`
   *  and the feedback memory's tags. Lets the reflection prompt
   *  cluster reactions ("the user reacted with `:angry:` three times
   *  this week"). */
  issueType: string
}

/**
 * Canonical reaction map. Keys are normalised via
 * `normalizeReactionKey`. Both the Slack name (`thumbsup`) and the
 * raw unicode (`👍`) are included so a single lookup handles both
 * channels.
 *
 * Issue-type labels mirror the web feedback modal's slugs where they
 * overlap (`unhelpful`, `incorrect`, `inappropriate`) so the
 * reflection LLM sees a consistent vocabulary regardless of source.
 */
const REACTION_MAP: Record<string, ReactionClassification> = {
  // ── Positive ────────────────────────────────────────────────
  // Thumbs / approval
  '+1': { kind: 'positive', issueType: 'thumbsup' },
  thumbsup: { kind: 'positive', issueType: 'thumbsup' },
  'thumbs_up': { kind: 'positive', issueType: 'thumbsup' },
  '👍': { kind: 'positive', issueType: 'thumbsup' },
  // Applause
  clap: { kind: 'positive', issueType: 'applause' },
  clapping_hands: { kind: 'positive', issueType: 'applause' },
  '👏': { kind: 'positive', issueType: 'applause' },
  // Celebration
  tada: { kind: 'positive', issueType: 'celebration' },
  party_popper: { kind: 'positive', issueType: 'celebration' },
  '🎉': { kind: 'positive', issueType: 'celebration' },
  // Affirmation
  'white_check_mark': { kind: 'positive', issueType: 'affirmation' },
  'check_mark_button': { kind: 'positive', issueType: 'affirmation' },
  heavy_check_mark: { kind: 'positive', issueType: 'affirmation' },
  '✅': { kind: 'positive', issueType: 'affirmation' },
  // Strong approval / excellent
  '100': { kind: 'positive', issueType: 'excellent' },
  hundred_points: { kind: 'positive', issueType: 'excellent' },
  '💯': { kind: 'positive', issueType: 'excellent' },
  fire: { kind: 'positive', issueType: 'excellent' },
  '🔥': { kind: 'positive', issueType: 'excellent' },
  // Heart / love
  heart: { kind: 'positive', issueType: 'love' },
  red_heart: { kind: 'positive', issueType: 'love' },
  '❤': { kind: 'positive', issueType: 'love' },
  heart_eyes: { kind: 'positive', issueType: 'love' },
  smiling_face_with_heart_eyes: { kind: 'positive', issueType: 'love' },
  '😍': { kind: 'positive', issueType: 'love' },
  // Raised hands / muscle
  raised_hands: { kind: 'positive', issueType: 'applause' },
  '🙌': { kind: 'positive', issueType: 'applause' },
  muscle: { kind: 'positive', issueType: 'strong' },
  flexed_biceps: { kind: 'positive', issueType: 'strong' },
  '💪': { kind: 'positive', issueType: 'strong' },
  // Star / sparkle
  star: { kind: 'positive', issueType: 'excellent' },
  '⭐': { kind: 'positive', issueType: 'excellent' },
  sparkles: { kind: 'positive', issueType: 'excellent' },
  '✨': { kind: 'positive', issueType: 'excellent' },

  // ── Negative ────────────────────────────────────────────────
  // Thumbs-down
  '-1': { kind: 'negative', issueType: 'thumbsdown' },
  thumbsdown: { kind: 'negative', issueType: 'thumbsdown' },
  'thumbs_down': { kind: 'negative', issueType: 'thumbsdown' },
  '👎': { kind: 'negative', issueType: 'thumbsdown' },
  // Wrong / cross
  x: { kind: 'negative', issueType: 'incorrect' },
  cross_mark: { kind: 'negative', issueType: 'incorrect' },
  negative_squared_cross_mark: { kind: 'negative', issueType: 'incorrect' },
  '❌': { kind: 'negative', issueType: 'incorrect' },
  '❎': { kind: 'negative', issueType: 'incorrect' },
  // Prohibition
  'no_entry_sign': { kind: 'negative', issueType: 'inappropriate' },
  prohibited: { kind: 'negative', issueType: 'inappropriate' },
  '🚫': { kind: 'negative', issueType: 'inappropriate' },
  // Anger / frustration
  angry: { kind: 'negative', issueType: 'frustration' },
  angry_face: { kind: 'negative', issueType: 'frustration' },
  '😠': { kind: 'negative', issueType: 'frustration' },
  rage: { kind: 'negative', issueType: 'frustration' },
  pouting_face: { kind: 'negative', issueType: 'frustration' },
  '😡': { kind: 'negative', issueType: 'frustration' },
  triumph: { kind: 'negative', issueType: 'frustration' },
  face_with_steam_from_nose: { kind: 'negative', issueType: 'frustration' },
  '😤': { kind: 'negative', issueType: 'frustration' },
  // Confusion
  thinking: { kind: 'negative', issueType: 'unclear' },
  thinking_face: { kind: 'negative', issueType: 'unclear' },
  '🤔': { kind: 'negative', issueType: 'unclear' },
  confused: { kind: 'negative', issueType: 'unclear' },
  confused_face: { kind: 'negative', issueType: 'unclear' },
  '😕': { kind: 'negative', issueType: 'unclear' },
  // Disappointment
  disappointed: { kind: 'negative', issueType: 'disappointed' },
  disappointed_face: { kind: 'negative', issueType: 'disappointed' },
  '😞': { kind: 'negative', issueType: 'disappointed' },
  pensive: { kind: 'negative', issueType: 'disappointed' },
  pensive_face: { kind: 'negative', issueType: 'disappointed' },
  '😔': { kind: 'negative', issueType: 'disappointed' },
  cry: { kind: 'negative', issueType: 'disappointed' },
  crying_face: { kind: 'negative', issueType: 'disappointed' },
  '😢': { kind: 'negative', issueType: 'disappointed' },
  sob: { kind: 'negative', issueType: 'disappointed' },
  loudly_crying_face: { kind: 'negative', issueType: 'disappointed' },
  '😭': { kind: 'negative', issueType: 'disappointed' },
  // Eye-roll / dismissive
  'face_with_rolling_eyes': { kind: 'negative', issueType: 'dismissive' },
  rolling_eyes: { kind: 'negative', issueType: 'dismissive' },
  '🙄': { kind: 'negative', issueType: 'dismissive' },
  // Vomit / strong disgust
  nauseated_face: { kind: 'negative', issueType: 'strong_disgust' },
  '🤢': { kind: 'negative', issueType: 'strong_disgust' },
  face_vomiting: { kind: 'negative', issueType: 'strong_disgust' },
  vomiting_face: { kind: 'negative', issueType: 'strong_disgust' },
  '🤮': { kind: 'negative', issueType: 'strong_disgust' },
  // Boring / sleeping
  sleeping: { kind: 'negative', issueType: 'boring' },
  sleeping_face: { kind: 'negative', issueType: 'boring' },
  '😴': { kind: 'negative', issueType: 'boring' },
  // Side-eye / suspicious
  monocle_face: { kind: 'negative', issueType: 'suspicious' },
  face_with_monocle: { kind: 'negative', issueType: 'suspicious' },
  '🧐': { kind: 'negative', issueType: 'suspicious' },
}

/**
 * Classify a raw emoji / Slack name into a feedback shape, or
 * `null` if the emoji is ambiguous and should be silently ignored.
 *
 * Examples:
 *   classifyReaction('thumbsup')          // {kind:'positive', issueType:'thumbsup'}
 *   classifyReaction('+1::skin-tone-4')   // {kind:'positive', issueType:'thumbsup'}
 *   classifyReaction('👎')                 // {kind:'negative', issueType:'thumbsdown'}
 *   classifyReaction('👍🏽')                // {kind:'positive', issueType:'thumbsup'}
 *   classifyReaction('eyes')               // null  (ambiguous — could mean "looking at this")
 *   classifyReaction('pray')               // null  (ambiguous — could be thanks OR high-five)
 *   classifyReaction('shrug')              // null  (ambiguous)
 */
export function classifyReaction(rawEmoji: string): ReactionClassification | null {
  const key = normalizeReactionKey(rawEmoji)
  if (key.length === 0) return null
  return REACTION_MAP[key] ?? null
}

/**
 * For analytics: the canonical normalised label to stamp on the
 * `analytics_events.metadata.details` field. Reflection prompt
 * formatter reads this to display "user reaction: `:thumbsdown:`".
 */
export function reactionDetailsLabel(rawEmoji: string): string {
  const key = normalizeReactionKey(rawEmoji)
  return `:${key}:`
}
