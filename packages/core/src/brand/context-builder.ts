/**
 * Build the `# Brand` L1 prompt block.
 *
 * Sits in the stable prefix of `buildFullSystemPrompt()` beside
 * `# Workspace Files` (see `packages/api/src/routes/_prompt-builder.ts`).
 * Never a volatile user-role tail: the block's whole job is to be present on
 * every turn, and moving per-turn context into the user role is what leaked
 * hidden metadata on 2026-08-01 (the prompt-cache-alignment invariant).
 *
 * ## Why this block exists
 *
 * A knowledge base can hold a brand's voice guide, but retrieval is pull-only
 * — the voice reaches a turn only when the model happens to search for it, so
 * it never governs the turns that most need it (the ones where the model is
 * simply writing). This block is the ambient layer: the writing rules the
 * brand has actually decided, present unconditionally, small enough to ride
 * the cache.
 *
 * ## What goes in, and what deliberately does not
 *
 * The block carries only the ACTIVE APPROVED version of the workspace's
 * default brand. A draft is by definition not yet what the company stands
 * behind, and an assistant is one of the things that can write a draft —
 * putting drafts here would let the model widen its own brand rules.
 *
 * It also carries only per-turn writing rules: positioning, tagline, voice,
 * vocabulary, capitalization, restricted terms. Colors, typography, logo
 * bindings, rights, and claims stay out. They are consumed by code (theme
 * seeds, template compilers, release gates), not by prose, and a hex value in
 * a system prompt is 2,500 characters of cache spent on something the model
 * cannot act on.
 *
 * ## The cap
 *
 * Hard-capped at {@link BRAND_DIGEST_CHAR_CAP}. Field groups are emitted in
 * priority order and the builder stops when the next group would not fit, so
 * a brand with forty voice traits degrades by losing its least-load-bearing
 * sections rather than by truncating mid-sentence or by quietly displacing
 * everything else in the stable prefix.
 *
 * Spec: docs/architecture/features/brand.md → "L1 prompt block"
 *
 * [COMP:brand/prompt-context]
 */

import type { BrandRecord } from '@use-brian/shared'

const HEADER = '# Brand'

/**
 * Hard ceiling on the rendered block, including the header and the closing
 * instruction. ~2,500 characters is roughly 600 tokens — enough for the
 * writing rules of a fully-specified brand, small enough that adding it to
 * every workspace's stable prefix is not a cost anyone has to think about.
 */
export const BRAND_DIGEST_CHAR_CAP = 2500

/**
 * The memory-dedup guard (decision D11), mirroring the knowledge-base rule in
 * Layer 1. Without it "our primary color is navy" accumulates as a memory on
 * the first turn that discusses branding, and then the workspace has two
 * sources of truth that drift — the record, which is governed and versioned,
 * and a memory, which is neither.
 *
 * Always emitted, and always last: it is an instruction about everything
 * above it.
 */
const DEDUP_LINE =
  'These brand facts are the source of truth and are already recorded - do not save them as memories. Save only what someone tells you about how they want the brand applied, or a decision that changes it.'

/** How a caller names the brand whose digest this is. */
export type BrandDigestInput = {
  /** The brand's display name. */
  name: string
  /** The brand's slug, so the model can name the record it is reading from. */
  slug: string
  /** The ACTIVE APPROVED record. Never a draft. */
  record: BrandRecord
  /** Version number of the approved record, for provenance. */
  version: number
}

/** One renderable group, in priority order. */
type Section = { text: string }

function bullet(label: string, value: string): string {
  return `- ${label}: ${value}`
}

/**
 * Group the digest's sections, most load-bearing first.
 *
 * The order is a claim about what actually changes a turn's output. Voice and
 * vocabulary come before strategy because they alter every sentence the model
 * writes; strategy alters the rare turn that argues about positioning.
 * Capitalization and restricted terms sit near the top for the same reason a
 * spelling rule beats a mission statement: they are mechanical, checkable,
 * and wrong-looking when missed.
 */
function sectionsFor(input: BrandDigestInput): Section[] {
  const { record } = input
  const sections: Section[] = []

  // 1. Identity — who this is, in one line each.
  const identity: string[] = []
  const displayName = record.naming.publicName || record.naming.name
  identity.push(bullet('Name', displayName))
  if (record.naming.descriptor) identity.push(bullet('Descriptor', record.naming.descriptor))
  if (record.naming.tagline) identity.push(bullet('Tagline', record.naming.tagline))
  if (record.messaging?.oneLine) identity.push(bullet('Positioning', record.messaging.oneLine))
  sections.push({ text: identity.join('\n') })

  // 2. Mechanical writing rules. Cheapest to obey, most visibly wrong when
  //    missed, so they outrank everything discretionary below.
  const rules: string[] = []
  if (record.naming.capitalization) rules.push(bullet('Capitalization', record.naming.capitalization))
  if (record.naming.restrictedTerms.length > 0) {
    rules.push(bullet('Never use these terms', record.naming.restrictedTerms.join(', ')))
  }
  if (rules.length > 0) sections.push({ text: `## Writing rules\n${rules.join('\n')}` })

  // 3. Voice. The `{trait, means, avoid}` triple is what makes it actionable;
  //    a bare trait list would be decoration.
  const voice = record.messaging?.voice ?? []
  if (voice.length > 0) {
    const lines = voice.map((v) => `- ${v.trait}: ${v.means}. Avoid: ${v.avoid}`)
    sections.push({ text: `## Voice\n${lines.join('\n')}` })
  }

  // 4. Vocabulary.
  const vocab: string[] = []
  const preferred = record.messaging?.preferred ?? []
  const avoid = record.messaging?.avoid ?? []
  if (preferred.length > 0) vocab.push(bullet('Prefer', preferred.join(', ')))
  if (avoid.length > 0) vocab.push(bullet('Avoid', avoid.join(', ')))
  const toneNotes = record.messaging?.toneNotes ?? []
  if (toneNotes.length > 0) vocab.push(bullet('Tone', toneNotes.join(' ')))
  if (vocab.length > 0) sections.push({ text: `## Vocabulary\n${vocab.join('\n')}` })

  // 5. Positioning detail — the turns that argue about what the brand is.
  const strategy: string[] = []
  if (record.strategy?.audience.length) strategy.push(bullet('Audience', record.strategy.audience.join('; ')))
  if (record.strategy?.differentiators.length) {
    strategy.push(bullet('Differentiators', record.strategy.differentiators.join('; ')))
  }
  if (record.strategy?.notPersonality.length) {
    strategy.push(bullet('Deliberately not', record.strategy.notPersonality.join(', ')))
  }
  if (strategy.length > 0) sections.push({ text: `## Positioning\n${strategy.join('\n')}` })

  return sections
}

/**
 * The pointer footer.
 *
 * Deliberately tool-agnostic (the Layer 1 tool-awareness rule): it names the
 * record and the knowledge-base paths, never a tool. An assistant without the
 * `brand` capability never sees this block at all, but an assistant that has
 * it may still have its brand tools blocked by policy — a block that told the
 * model to "call getBrand" would then send it hunting for a tool it cannot
 * reach.
 */
function pointerLines(input: BrandDigestInput): string {
  const lines: string[] = [
    `The full brand record (colors, typography, logo variants, applications, claims, rights) is stored in this workspace as brand "${input.slug}", approved version ${input.version}. Consult it before making a branding decision this summary does not cover, and never invent a value it would have.`,
  ]
  const sources = input.record.sources.filter((s) => s.kbPath)
  if (sources.length > 0) {
    const list = sources.slice(0, 5).map((s) => `${s.kbPath} (${s.label})`).join('; ')
    lines.push(`Long-form brand material lives in the knowledge base at: ${list}.`)
  }
  return lines.join('\n')
}

/**
 * Render the `# Brand` block, or `null` when there is nothing to say.
 *
 * Returns `null` — not an empty block — when no approved brand exists. Unlike
 * `# Workspace Files`, which always emits so its presence signals that files
 * are available, an absent brand block must produce a byte-identical prompt
 * to today's for every existing workspace and every OSS install. A "no brand
 * configured yet" placeholder would change the stable prefix of every
 * workspace on earth to advertise a feature almost none of them use.
 */
export function buildBrandContext(input: BrandDigestInput | null): string | null {
  if (!input) return null

  const sections = sectionsFor(input)
  const pointers = pointerLines(input)
  const footer = `\n\n${pointers}\n\n${DEDUP_LINE}`

  // The header, pointers, and dedup line are non-negotiable: without them the
  // block is unattributed facts with no route to the rest of the record. They
  // reserve their space first, and the field groups fill what is left.
  const budget = BRAND_DIGEST_CHAR_CAP - HEADER.length - footer.length
  const kept: string[] = []
  let used = 0
  for (const section of sections) {
    const cost = section.text.length + (kept.length > 0 ? 2 : 0)
    if (used + cost > budget) break
    kept.push(section.text)
    used += cost
  }

  // Every section overflowed (a pathological single group). Emit the block
  // anyway: the pointer lines alone still route the model to the record,
  // which beats silently dropping the brand from the turn.
  const body = kept.join('\n\n')
  return `${HEADER}\n${body}${footer}`
}

/**
 * A compact "write in this voice" fragment for a GENERATION prompt.
 *
 * Distinct from {@link buildBrandContext} on purpose. The L1 digest is an
 * ambient block for a conversational turn: it carries pointer lines to the
 * full record and the D11 memory-dedup guard, both of which are noise in a
 * one-shot generation call that has no tool surface and no memory system to
 * dedup against. Reusing it here would spend a generation prompt's budget on
 * instructions the model cannot act on.
 *
 * ## Why this exists at all
 *
 * Office generation builds its own system prompts (`LETTER_SYSTEM_PROMPT` and
 * friends) and never routes through `buildFullSystemPrompt`, so the `# Brand`
 * block never reached it. The result was the feature's headline promise being
 * false exactly where it is most visible: the assistant honoured the brand
 * voice in chat and ignored it when generating the company's documents.
 *
 * Returns `null` when the record carries no writing rules worth stating — a
 * brand with only a name should add nothing to a generation prompt.
 *
 * [COMP:brand/prompt-context]
 */
export function buildBrandVoiceFragment(record: BrandRecord | null): string | null {
  if (!record) return null

  const lines: string[] = []
  const naming = record.naming
  const displayName = naming.publicName || naming.name

  if (naming.capitalization) lines.push(`- Write the name exactly as: ${naming.capitalization}`)
  else lines.push(`- Refer to the company as "${displayName}".`)
  if (naming.restrictedTerms.length > 0) {
    lines.push(`- Never use these terms: ${naming.restrictedTerms.join(', ')}`)
  }

  const voice = record.messaging?.voice ?? []
  for (const trait of voice.slice(0, 6)) {
    lines.push(`- ${trait.trait}: ${trait.means}. Avoid: ${trait.avoid}`)
  }
  const preferred = record.messaging?.preferred ?? []
  const avoid = record.messaging?.avoid ?? []
  if (preferred.length > 0) lines.push(`- Prefer these words: ${preferred.join(', ')}`)
  if (avoid.length > 0) lines.push(`- Avoid these words: ${avoid.join(', ')}`)
  for (const note of (record.messaging?.toneNotes ?? []).slice(0, 3)) lines.push(`- ${note}`)

  // A name alone is not a voice. Emitting a block that says only "call the
  // company X" would add tokens to every generation for no behavioural change.
  if (lines.length <= 1 && voice.length === 0) return null

  const body = lines.join('\n')
  // Hard cap for the same reason the digest has one: a generation prompt's
  // budget belongs mostly to the artifact's own instructions.
  const capped = body.length > 1200 ? `${body.slice(0, 1200).replace(/\n[^\n]*$/, '')}` : body
  return `Brand voice for ${displayName} — follow it in every word you write. It does not override the output format or the factual rules above; where they conflict, they win.\n${capped}`
}
