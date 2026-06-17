/**
 * Shared system-prompt assembly for every chat route.
 *
 * Consolidates the block-ordering that used to be duplicated across
 * `chat.ts`, `telegram.ts`, `telegram-byo.ts`, `slack.ts`, and
 * `channel-pipeline.ts`. New injections (episodic context, per-turn
 * topic hint, tightened reply anchor) land here so the four routes
 * stay in lockstep.
 *
 * # Block order (cache-aligned)
 *
 * The assembly is ordered so that **stable** blocks precede **volatile**
 * blocks. Gemini's prompt cache keys on a prefix match: everything above
 * the first byte-level divergence is a cache hit; everything from the
 * first divergence onward pays full input price. Moving per-turn content
 * (datetime, topic classifier output, reply anchor, pending messages)
 * below memory + skills means memory and skills stay cached across
 * unchanged turns.
 *
 *   STABLE (cacheable across turns when unchanged)
 *     1. Layer 1 base prompt
 *     2. Layer 2 assistant custom instructions  (per-assistant persona)
 *     3. Memory context (SOUL + identities + index + team)
 *     4. Skills fragment
 *
 *   VOLATILE (changes every turn or often)
 *     5. # Open commitments — from session_state store (always-on tier)
 *     6. # User Context  — datetime + timezone
 *     7. # Relevant topic history — from episodic store
 *     8. # Current topic — per-turn classifier hint (references #7)
 *     9. # Reply context — when the user replied to a specific message
 *    10. Group-chat context (group messaging channels only)
 *    11. Unavailable capabilities
 *    12. Pending messages fragment
 *    13. Preflight context (web coordinator mode wraps separately)
 *
 * Within the volatile section, order follows referential dependency:
 * the topic hint's "resume" / "cross-topic" states point the model at
 * the "Relevant topic history" above, so episodic precedes the hint.
 *
 * Layer 2 is appended immediately after Layer 1 (not woven into it)
 * so the Layer 1 cache key never shifts across assistants, and so
 * Layer 1's honesty / tool-awareness / memory rules remain authoritative
 * when a user's custom instructions are vague or conflicting.
 */

import type { TopicClassification } from '@sidanclaw/core'
import { FOLLOW_UP_QUESTIONS_ADDENDUM } from '@sidanclaw/core'
import type { ResolveAppSoul } from '../tool-injection-port.js'

export type ReplyContextInput = {
  /** The resolved text of the replied-to message. */
  text: string
  /** Whether the replied-to message was from the assistant or another user. */
  fromAssistant: boolean
}

export type BuildPromptParams = {
  basePrompt: string
  /**
   * Layer 2 — per-assistant custom instructions set by the owner in the
   * assistant settings UI. Appended directly after `basePrompt` so
   * Layer 1's behavioral guarantees stay intact while the owner's tone
   * and persona apply on top. `null` / empty / whitespace-only skips
   * the block entirely.
   */
  assistantInstructions?: string | null
  /**
   * Workspace-level prompt-evolution snippet (Layer 2 addendum).
   * Built by the `memory-evolution-worker` from aggregated
   * `memory_verifications` patterns — biases the model toward
   * scope/sensitivity choices the workspace has consistently
   * corrected toward. Injected immediately after the static Layer 2
   * block so it rides the same cache prefix and stays grouped with
   * persona instructions.
   *
   * `null` / empty / whitespace-only skips the block — that's the
   * common case (the worker only emits a snippet when a pattern
   * crosses the significance threshold). See
   * `docs/architecture/brain/corrections.md` → "Workspace-level
   * prompt evolution".
   */
  workspaceEvolutionSnippet?: string | null
  /**
   * Wall-clock time formatted in the user's *presence* timezone — i.e.
   * where they currently are, not their home/anchor zone. The chat
   * route resolves presence from the live `X-Client-Timezone` header
   * (web) or the most recent fresh observation stored on `users`
   * (other channels), and falls back to the anchor when neither is
   * available. Render this verbatim — do not re-derive on the model
   * side.
   */
  currentDateTime: string
  /**
   * The IANA zone matching `currentDateTime` (presence zone). Shown
   * to the model so it can name the location truthfully instead of
   * inferring one from soul/episodic context.
   */
  timezone: string
  /**
   * The user's anchor (home / scheduling) timezone, if it differs
   * from `timezone`. When set, the prompt block makes the
   * presence-vs-anchor split explicit so the model knows which zone
   * to use for reminders versus "what time is it now". Null/equal
   * collapses the block to its original single-line form.
   */
  anchorTimezone?: string | null
  memoryContext: string
  /**
   * `# Workspace Files` index — the L1 ambient awareness block for the
   * Q3 filesystem primitive (company-brain §10). Built by
   * `buildWorkspaceFilesContext()` from `@sidanclaw/core`. Sits in the
   * stable prefix right after `# Memories`. Pass `null` / empty string
   * to omit (e.g. assistant lacks the `files` capability, or no
   * workspace bound to the assistant).
   */
  workspaceFilesContext?: string | null
  /**
   * Always-on session-state tier. Formatted by `buildSessionStateBlock`
   * in `@sidanclaw/core`. Unlike `episodicContext`, this is injected on
   * every turn regardless of topic-classifier verdict — its job is to
   * surface "what's open / resolved right now" so the model doesn't
   * re-derive it from raw history. `null` or empty string = block omitted.
   *
   * See `docs/architecture/context-engine/session-state.md`.
   */
  sessionStateBlock?: string | null
  /**
   * Drive-oriented execution-plan tier. Formatted by `buildActivePlanBlock`
   * in `@sidanclaw/core`. Injected ONLY while the session has an `active`
   * task attempt (the builder returns `null` for dormant/archived attempts),
   * so it cannot leak into an unrelated turn. `null` or empty = block omitted.
   *
   * See `docs/architecture/context-engine/execution-plan.md`.
   */
  activePlanBlock?: string | null
  episodicContext?: string | null
  topicHint?: TopicClassification | null
  replyContext?: ReplyContextInput | null
  groupChatContext?: string
  skillsFragment?: string
  /**
   * Doc page-authoring protocol injected as a SKILL block for an assistant
   * working on the doc surface that is not itself a `kind='app'` doc
   * assistant (the workspace primary by default, or any assistant the user
   * switched to). Built by `buildDocSkillBlock` in `@sidanclaw/core`. Sits in
   * the stable prefix right after the skills fragment so it rides the prompt
   * cache within a doc session. `null` / empty = omitted (the common case
   * off-doc). Only set when the doc tools are actually injected
   * (tool-awareness rule) — the chat route gates it on the doc surface.
   */
  docSkillBlock?: string | null
  unavailableCapabilitiesPrompt?: string
  pendingMessagesFragment?: string
  preflightContext?: string
}

/**
 * Resolve the Layer 1 base prompt for a given assistant.
 *
 * Standard assistants (`kind='standard'`) use the global `defaultPrompt`
 * (the route's configured `LAYER_1_SYSTEM_PROMPT`). App assistants
 * (`kind='app'`) get their soul from the injected `resolveAppSoul` host hook
 * (e.g. a publishing app's soul). The open build leaves the hook unset, so app
 * assistants fall back to the default prompt. This keeps the open prompt builder
 * free of any app-type-specific soul content.
 */
export function resolveLayer1Prompt(params: {
  defaultPrompt: string
  assistant: {
    kind: 'standard' | 'app' | 'primary'
    name: string
    /** Set iff kind='app'. Forwarded to `resolveAppSoul` to pick a soul. */
    appType?: string | null
  }
  /** When assistant.kind='app', the owning team's display info. */
  team?: { name: string; purpose?: string | null } | null
  assistantBio?: string | null
  /** Opaque host-defined prompt mode, forwarded to `resolveAppSoul`. */
  mode?: string
  /** Host hook that builds an app assistant's soul; open default = unset. */
  resolveAppSoul?: ResolveAppSoul
}): string {
  if (params.assistant.kind !== 'app') {
    return params.defaultPrompt
  }

  const soul = params.resolveAppSoul?.({
    appType: params.assistant.appType ?? null,
    name: params.assistant.name,
    team: params.team,
    assistantBio: params.assistantBio,
    mode: params.mode,
  })
  if (soul) return soul

  // No host soul for this app assistant (open build, or an unrecognised
  // appType — a data bug the 082 CHECK constraint should prevent). Fall back
  // to the default prompt rather than crashing: the chat route stays alive,
  // visibly generic, and the gap is traceable via the warning.
  console.warn(
    `[prompt-builder] no host soul for app assistant appType=${params.assistant.appType ?? 'null'}; falling back to default prompt`,
  )
  return params.defaultPrompt
}

/**
 * Append the `<followup>[...]</followup>` chip addendum to a base prompt
 * when — and only when — the requesting client declares it renders chips.
 *
 * Follow-up chips are opt-in PER CLIENT, not per mount: the same /api/chat
 * mount serves chip-rendering surfaces (apps/web) and non-chip surfaces
 * (the doc editor chat, whose model output is authored into document
 * content). Gating on a client-sent flag is what stops the raw tag leaking
 * into doc pages. `app` assistants (doc / feed) author their own soul
 * and never want the tag, so they're excluded regardless of the flag.
 *
 * See `docs/architecture/features/follow-up-questions.md`.
 */
export function maybeAppendFollowupChips(
  basePrompt: string,
  opts: { followupChips?: boolean; assistantKind: 'standard' | 'app' | 'primary' },
): string {
  if (opts.followupChips !== true || opts.assistantKind === 'app') {
    return basePrompt
  }
  return `${basePrompt}\n\n${FOLLOW_UP_QUESTIONS_ADDENDUM}`
}

/**
 * Section collector shared by `buildFullSystemPrompt` (legacy combined form)
 * and `buildSplitSystemPrompt` (cache-stable split form). Emits the STABLE
 * sections (change only when the assistant / workspace / memory configuration
 * changes) separately from the VOLATILE per-turn sections (clock, topic hint,
 * session state, reply context, …).
 *
 * Why the split exists: the provider serializes the system prompt BEFORE the
 * conversation history, so a single per-turn byte in the system prompt (the
 * minute-resolution clock was the worst offender) invalidates the implicit
 * prompt-cache prefix for the ENTIRE request — every turn's first model call
 * re-prefilled the whole history cold (20-60s TTFT on long sessions, the
 * dominant doc-surface latency and the trigger for the 30s idle-abort storms).
 * The chat route sends only the stable half as the system prompt and delivers
 * the volatile half as a `<turn_context>` block attached to the newest user
 * message — the cache-neutral tail position. See
 * `docs/architecture/engine/query-loop.md` → "Turn-context envelope".
 */
function collectPromptSections(
  p: BuildPromptParams,
): { stable: string[]; volatile: string[] } {
  const sections: string[] = []

  // ── STABLE prefix (cacheable) ─────────────────────────────────

  // 1. Layer 1 — global base prompt.
  sections.push(p.basePrompt)

  // 2. Layer 2 — assistant-specific custom instructions.
  const layer2 = p.assistantInstructions?.trim()
  if (layer2 && layer2.length > 0) {
    sections.push(`# Assistant instructions\n${layer2}`)
  }

  // 2.5. Workspace-level prompt-evolution snippet. Sits between the
  //      static Layer 2 and the memory context so it remains part of
  //      the stable prefix (cacheable across turns; the snippet only
  //      changes on a worker tick). The snippet itself is the full
  //      block — header + bullets — produced by `buildPromptSnippet`
  //      in `packages/api/src/workers/memory-evolution-worker.ts`, so
  //      no extra header is added here.
  const evo = p.workspaceEvolutionSnippet?.trim()
  if (evo && evo.length > 0) {
    sections.push(evo)
  }

  // 3. Memory context.
  //    Note: buildMemoryContext() always returns a non-empty string
  //    (falls back to "## Memory\nNo memories yet…"). Trim defensively
  //    so whitespace-only input still triggers the empty-skip below.
  if (p.memoryContext && p.memoryContext.trim().length > 0) {
    sections.push(p.memoryContext)
  }

  // 3.5. Workspace files index (Q3 / company-brain §10). Built by
  //      `buildWorkspaceFilesContext()`. Conditional on the assistant
  //      having the `files` capability (the caller decides whether to
  //      compute this block at all). Sits in the stable prefix so it
  //      can ride the prompt cache.
  if (p.workspaceFilesContext && p.workspaceFilesContext.trim().length > 0) {
    sections.push(p.workspaceFilesContext)
  }

  // 4. Skills fragment.
  if (p.skillsFragment && p.skillsFragment.length > 0) {
    sections.push(p.skillsFragment.replace(/^\n+/, ''))
  }

  // 4.5. Doc skill block. The page-authoring protocol injected as a skill
  //      for a non-doc-app assistant working on the doc surface (the
  //      workspace primary by default). Unlike the doc soul, this is an
  //      addendum — the host assistant keeps its own Layer-1 identity above and
  //      gains the authoring discipline here. Sits in the stable prefix so it
  //      rides the prompt cache within a doc session; a research toggle
  //      changes the mode and breaks cache for that turn, same as the soul.
  //      Set only when the doc tools are actually injected (tool-awareness
  //      rule); a legacy doc app assistant gets the protocol from its soul,
  //      so this stays null there (no double-injection).
  if (p.docSkillBlock && p.docSkillBlock.trim().length > 0) {
    sections.push(p.docSkillBlock)
  }

  // Everything pushed above is the stable half; everything below is
  // per-turn. `splice(0)` drains the accumulator so the section code on
  // both sides stays byte-identical to the pre-split builder.
  const stable = sections.splice(0)

  // ── VOLATILE suffix (changes per turn) ────────────────────────

  // 5. Open commitments (session-state tier). Unconditional — injected on
  //    every turn regardless of topic classifier verdict. Placed at the top
  //    of the volatile section so the model reads current open/resolved
  //    state before the rest of the per-turn context.
  if (p.sessionStateBlock && p.sessionStateBlock.trim().length > 0) {
    sections.push(p.sessionStateBlock)
  }

  // 6. Active plan (execution-plan tier). Conditional — present only while a
  //    task attempt is `active`. Drive counterpart to # Open commitments:
  //    keeps the model working open steps instead of concluding mid-task.
  if (p.activePlanBlock && p.activePlanBlock.trim().length > 0) {
    sections.push(p.activePlanBlock)
  }

  // 7. User context (datetime + timezone).
  //    When the user is travelling, presence (where they are now) and
  //    anchor (their home/scheduling zone) differ. We surface both so
  //    the model can answer "what time is it" with the local zone
  //    while still routing recurring reminders through the anchor.
  //    The third line is an explicit instruction because models
  //    otherwise tend to relabel the local zone with whatever city
  //    soul/episodic context recently mentioned (observed in prod —
  //    a Hong Kong-anchored user in Tokyo got told "1:40 AM in Tokyo"
  //    instead of "2:40 AM in Tokyo" because the time string carried
  //    the anchor offset but the model swapped in the trip city).
  const travelling =
    p.anchorTimezone && p.anchorTimezone.length > 0 && p.anchorTimezone !== p.timezone
  if (travelling) {
    sections.push(
      `# User Context\n` +
        `Current local time (where the user is now): ${p.currentDateTime}\n` +
        `Local timezone: ${p.timezone}\n` +
        `Home timezone (used for recurring reminders / scheduled jobs): ${p.anchorTimezone}\n` +
        `The user is travelling. When stating the current time or naming a place, use the local timezone above — do not substitute a city from earlier conversation context. Use the home timezone for scheduling unless the user specifies otherwise.`,
    )
  } else {
    sections.push(
      `# User Context\nCurrent date and time: ${p.currentDateTime}\nTimezone: ${p.timezone}`,
    )
  }

  // 7. Episodic topic history (must precede the topic hint — the hint's
  //    "resume" / "cross-topic" states reference this block).
  if (p.episodicContext && p.episodicContext.trim().length > 0) {
    sections.push(p.episodicContext)
  }

  // 8. Current topic (per-turn classifier).
  const topicBlock = renderTopicHint(p.topicHint)
  if (topicBlock) sections.push(topicBlock)

  // 9. Reply context.
  const replyBlock = renderReplyContext(p.replyContext)
  if (replyBlock) sections.push(replyBlock)

  // 10. Group-chat context.
  if (p.groupChatContext && p.groupChatContext.trim().length > 0) {
    sections.push(p.groupChatContext)
  }

  // 11. Unavailable capabilities — "do not search for these" guardrail.
  if (p.unavailableCapabilitiesPrompt && p.unavailableCapabilitiesPrompt.length > 0) {
    sections.push(p.unavailableCapabilitiesPrompt.replace(/^\n+/, ''))
  }

  // 12. Pending inter-assistant messages.
  if (p.pendingMessagesFragment && p.pendingMessagesFragment.length > 0) {
    sections.push(p.pendingMessagesFragment.replace(/^\n+/, ''))
  }

  // 13. Preflight context (web, coordinator mode wraps separately).
  if (p.preflightContext && p.preflightContext.length > 0) {
    sections.push(p.preflightContext.replace(/^\n+/, ''))
  }

  return { stable, volatile: sections }
}

export function buildFullSystemPrompt(p: BuildPromptParams): string {
  const { stable, volatile } = collectPromptSections(p)
  return [...stable, ...volatile].join('\n\n')
}

export type SplitSystemPrompt = {
  /**
   * The stable sections joined — sent as the provider system prompt.
   * Byte-identical across the turns of a session unless the assistant /
   * workspace / memory configuration actually changes, so the provider's
   * implicit prompt cache covers it plus the whole history prefix.
   */
  stablePrompt: string
  /**
   * The volatile per-turn sections joined — attach to the newest user
   * message as a `<turn_context>` block (see `attachTurnContext` in
   * `chat.ts`). Empty string when no volatile section rendered.
   */
  turnContext: string
}

/**
 * Cache-stable split form of `buildFullSystemPrompt`: same sections, same
 * order, same bytes — but the volatile per-turn half is returned separately
 * instead of being appended to the system prompt. `buildFullSystemPrompt(p)`
 * is always equal to `[stablePrompt, turnContext].join('\n\n')` (modulo an
 * empty half).
 */
export function buildSplitSystemPrompt(p: BuildPromptParams): SplitSystemPrompt {
  const { stable, volatile } = collectPromptSections(p)
  return {
    stablePrompt: stable.join('\n\n'),
    turnContext: volatile.join('\n\n'),
  }
}

function renderTopicHint(hint: TopicClassification | null | undefined): string | null {
  if (!hint || hint.confidence === 0) return null
  if (hint.topic_label === '(uncategorized)') return null

  const lines = [`# Current topic`]
  switch (hint.state) {
    case 'continue':
      lines.push(
        `The current message continues the topic "${hint.topic_label}". Stay on this topic.`,
      )
      break
    case 'shift':
      lines.push(
        `The current message introduces a NEW topic: "${hint.topic_label}". Earlier topics in this session are no longer active — do not re-address them unless the user re-raises them.`,
      )
      break
    case 'resume':
      lines.push(
        `The user is RESUMING an earlier topic: "${hint.topic_label}". Use the "Relevant topic history" section above to pick up where you left off.`,
      )
      break
    case 'cross-topic': {
      const related = hint.related_topics?.length
        ? ` (also references: ${hint.related_topics.map((t) => `"${t}"`).join(', ')})`
        : ''
      lines.push(
        `The current message spans multiple topics. Active: "${hint.topic_label}"${related}. Use the "Relevant topic history" above for the other topics it references.`,
      )
      break
    }
  }
  return lines.join('\n')
}

function renderReplyContext(ctx: ReplyContextInput | null | undefined): string | null {
  if (!ctx || !ctx.text) return null
  const sender = ctx.fromAssistant ? 'you (the assistant)' : 'another user'
  return (
    `# Reply context\n` +
    `The user is specifically replying to this earlier message from ${sender}:\n  "${ctx.text.slice(0, 500)}"\n` +
    `Treat this as the primary referent for the current message. Do NOT re-address other recent topics unless the user re-raises them in the current message itself.`
  )
}
