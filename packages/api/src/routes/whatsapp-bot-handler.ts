/**
 * WhatsApp BotHandler — the trigger-gated responder in the dispatcher
 * fan-out (`whatsapp-dispatcher.ts`).
 *
 * The bot half of the listener/bot split. On each inbound message it:
 *   1. **Send-scope gate** — DMs by default; group replies are off unless the
 *      group is explicitly opted in (decision #2: the personal number stays
 *      read-only in groups by default).
 *   1b. **Access-control gate** — `botAnswerDecision`: drop senders the
 *      channel's access mode excludes (`allowlist` of numbers, or
 *      `group_members` = only people who share a group with the connected
 *      number), logging the deny reason. LID senders match via the
 *      connector-resolved `senderPnJid` PN twin. Telegram parity.
 *   2. **Trigger gate** — for groups a reply fires only when a
 *      `routing_mode='reply'` rule matches, evaluated by the shared ingest
 *      engine over the `'reply'`-mode rules. DMs are always answered (Telegram
 *      parity) in full-assistant mode; the legacy lightweight path keeps the
 *      DM trigger gate too.
 *   3. **Reply** — one of two modes:
 *      - **Full-assistant mode** (`runAssistant` supplied): hands the inbound to
 *        `processChannelMessage` (the same engine Telegram/Slack/web chat use) so
 *        the bot has the full Layer-1 prompt, memory, tools, research mode and
 *        session history. This is the brain-backed BYON bot mode.
 *      - **Lightweight persona mode** (legacy fallback): short-term history +
 *        optional brain context → single `assistant.systemPrompt` persona LLM
 *        call → wa-connector `/send`.
 *
 * The lightweight path **writes nothing to the brain** (it only reads). The
 * full-assistant path runs the normal pipeline, which persists session history
 * like every other channel.
 *
 * All side-effecting collaborators are injected so the handler's gating logic is
 * unit-testable without an LLM, a socket, or the DB. Production wiring supplies
 * the real engine pass / history / LLM / send in `apps/api`.
 *
 * [COMP:api/whatsapp-bot-handler]
 */

import type { WhatsAppHandler } from './whatsapp-dispatcher.js'

/**
 * Injected bot seam (mirrors `WhatsappIngestor`). Resolves the per-assistant
 * channel's capability + config and returns a ready bot `WhatsAppHandler` for
 * this message, or `null` when the channel is not a `'chat'`-capable bot
 * channel (so the dispatcher leaves it to the listener and/or the legacy
 * responder). Built in `apps/api` with the real LLM / session / send deps.
 */
export type WhatsappBot = {
  resolveHandler: (input: WhatsappBotInput) => Promise<WhatsAppHandler | null>
}

/** The inbound fields the bot evaluates. */
export type WhatsappBotInput = {
  channelId: string
  chatJid: string
  senderJid: string
  /**
   * The sender's phone-number JID when `senderJid` is a LID (privacy
   * addressing) and the connector resolved the PN twin. The access gate falls
   * back to this so an allowlisted number still matches under LID delivery.
   */
  senderPnJid?: string
  senderName?: string
  messageId: string
  text: string
  isGroup: boolean
  timestamp: number
  /**
   * Set only on a video auto-turn: the recording episode this turn fired for.
   * Threaded to the per-turn media token so media-fetching connectors resolve
   * THIS video, not the user's latest. See channel-pipeline `mediaEpisodeId`.
   */
  mediaEpisodeId?: string
  /** Durable local archive asset prepared by the inbound route. */
  archiveMediaRef?: {
    assetId: string
    sha256: string
    filename: string
    mime: string
    sizeBytes: number
  }
  archiveMediaType?: 'photo' | 'document' | 'voice' | 'audio' | 'video'
  archiveMediaMime?: string
  archiveMediaName?: string
  archiveMediaSizeBytes?: number
  archiveMediaAvailability?: 'missing' | 'failed'
  /** Set only after the BYON route durably enqueues the archive append. */
  archiveInboundPersisted?: boolean
}

/**
 * Who the bot may answer (Telegram-parity allowlist, WhatsApp flavour):
 *   - `'allow_all'` (default) — answer everyone.
 *   - `'allowlist'` — answer only senders whose number is in `allowedNumbers`.
 *   - `'blocklist'` — answer everyone EXCEPT senders whose number is in
 *     `blockedNumbers`.
 *   - `'group_members'` — answer only people who share a group with the
 *     connected number. A group message is inherently from a co-member (the
 *     number is in that group), so it always passes; a DM passes only when the
 *     sender's number is in `groupMemberNumbers` (the cached union of every
 *     group's participants, resolved by the wiring).
 *
 * The handler treats any unrecognized mode as `'allow_all'`.
 */
export type WhatsappBotAccessMode =
  | 'allow_all'
  | 'allowlist'
  | 'blocklist'
  | 'group_members'

/** Per-assistant-channel bot config (persona + send scope + access control). */
export type WhatsappBotConfig = {
  /** Persona system prompt — `assistant.systemPrompt`, or null for the default. */
  persona: string | null
  /**
   * Send scope. `'dm'` (default) replies only to direct messages; `'dm_and_groups'`
   * also replies in groups, but only those listed in `groupOptIn`.
   */
  sendScope: 'dm' | 'dm_and_groups'
  /** Groups the bot may reply in (only consulted when `sendScope` allows groups). */
  groupOptIn?: string[]
  /** Access-control mode. Omitted → `'allow_all'`. */
  accessMode?: WhatsappBotAccessMode
  /** Allowed sender numbers (normalized digits) when `accessMode='allowlist'`. */
  allowedNumbers?: string[]
  /** Blocked sender numbers (normalized digits) when `accessMode='blocklist'`. */
  blockedNumbers?: string[]
  /**
   * Cached union of group-participant numbers (normalized digits), consulted
   * for DMs when `accessMode='group_members'`. Resolved + cached by the wiring.
   */
  groupMemberNumbers?: string[]
}

/**
 * Normalize a WhatsApp JID or a user-typed number to comparable phone digits.
 * `'85291234567:3@s.whatsapp.net'` → `'85291234567'`; `'+852 9123 4567'` →
 * `'85291234567'`. Returns `null` for `@lid` JIDs (the member hides their
 * number, so it can't be matched) and for anything with fewer than 5 digits.
 */
export function normalizeWhatsappNumber(jidOrNumber: string): string | null {
  if (jidOrNumber.includes('@lid')) return null
  const local = jidOrNumber.split('@')[0]?.split(':')[0] ?? ''
  const digits = local.replace(/\D/g, '')
  return digits.length >= 5 ? digits : null
}

/** Why the access gate denied a sender — for the drop log. */
export type BotAnswerDenyReason =
  | 'lid_unidentifiable'
  | 'not_in_allowlist'
  | 'blocked'
  | 'not_group_member'

export type BotAnswerDecision =
  | { allowed: true }
  | { allowed: false; reason: BotAnswerDenyReason }

/**
 * Decide whether the bot may answer this sender under the channel's access
 * mode, with the deny reason for logging. Pure + synchronous — the wiring
 * pre-resolves `allowedNumbers` / `groupMemberNumbers` so the gate is a cheap
 * membership check at receive time. A LID sender is matched via the
 * connector-resolved `senderPnJid` PN twin; only when that is absent too is
 * the sender unidentifiable (`lid_unidentifiable`).
 */
export function botAnswerDecision(
  config: WhatsappBotConfig,
  input: WhatsappBotInput,
): BotAnswerDecision {
  const mode = config.accessMode ?? 'allow_all'
  if (mode === 'allow_all') return { allowed: true }
  // A group message is from a co-member of a group the number is in → always
  // allowed under group_members; the send-scope gate already governs groups.
  if (mode === 'group_members' && input.isGroup) return { allowed: true }
  const sender =
    normalizeWhatsappNumber(input.senderJid) ??
    (input.senderPnJid ? normalizeWhatsappNumber(input.senderPnJid) : null)
  if (mode === 'blocklist') {
    // Block only confirmed-blocked numbers. An unidentifiable sender (@lid
    // with no resolved PN) can't be matched, so it is allowed — blocking is
    // opt-out, not opt-in.
    if (!sender || !(config.blockedNumbers ?? []).includes(sender)) return { allowed: true }
    return { allowed: false, reason: 'blocked' }
  }
  // allowlist / group_members need a known number
  if (!sender) return { allowed: false, reason: 'lid_unidentifiable' }
  if (mode === 'allowlist') {
    return (config.allowedNumbers ?? []).includes(sender)
      ? { allowed: true }
      : { allowed: false, reason: 'not_in_allowlist' }
  }
  return (config.groupMemberNumbers ?? []).includes(sender)
    ? { allowed: true }
    : { allowed: false, reason: 'not_group_member' }
}

/** True when the bot may answer this sender — see `botAnswerDecision`. */
export function botMayAnswer(config: WhatsappBotConfig, input: WhatsappBotInput): boolean {
  return botAnswerDecision(config, input).allowed
}

export type WhatsappBotDeps = {
  /**
   * True when a `routing_mode='reply'` rule matches this message (the trigger).
   * Wraps the shared ingest engine's `'reply'`-mode pass in production.
   */
  evalTrigger: (input: WhatsappBotInput) => Promise<boolean>
  /** Short-term thread history for the chat (recent turns), as prompt text. */
  getRecentHistory: (chatJid: string) => Promise<string>
  /**
   * Long-term brain context for dual mode (Phase 5). Omitted in bot-only mode —
   * the bot then runs on short-term history alone.
   */
  getBrainContext?: (input: WhatsappBotInput) => Promise<string>
  /** Generate the persona reply. Empty / blank result → nothing is sent. */
  generateReply: (args: {
    persona: string | null
    history: string
    brainContext: string
    input: WhatsappBotInput
  }) => Promise<string>
  /** Send through wa-connector `/send`; the connector records the sent id for dedup. */
  send: (chatJid: string, text: string) => Promise<{ messageId: string }>
  /**
   * Full-assistant reply path. When supplied, the handler hands the inbound to
   * this callback (wired in `apps/api` to `processChannelMessage` + WhatsApp
   * hooks) instead of the lightweight `generateReply` pipeline — giving the bot
   * the full engine (Layer-1 prompt, memory, tools, research, sessions). The
   * callback owns sending, typing, confirmations and session persistence. When
   * absent the handler falls back to the lightweight persona reply. See
   * docs/architecture/channels/whatsapp.md → "BYON bot mode".
   */
  runAssistant?: (input: WhatsappBotInput) => Promise<void>
}

/**
 * True when the bot is allowed to reply to this message given its send scope.
 * DMs always pass; group messages pass only when groups are enabled AND the
 * specific group is opted in.
 */
export function botMaySend(config: WhatsappBotConfig, input: WhatsappBotInput): boolean {
  if (!input.isGroup) return true
  if (config.sendScope !== 'dm_and_groups') return false
  return (config.groupOptIn ?? []).includes(input.chatJid)
}

/**
 * Build the bot handler for one inbound message. Returns a `WhatsAppHandler`
 * whose `handle()` runs the scope → trigger → context → reply pipeline. Always
 * returns a handler (the gates live inside `handle`) so the dispatcher's
 * fan-out + failure isolation apply uniformly.
 */
export function buildWhatsappBotHandler(
  deps: WhatsappBotDeps,
  config: WhatsappBotConfig,
  input: WhatsappBotInput,
): WhatsAppHandler {
  return {
    kind: 'bot',
    async handle() {
      // 1. Send-scope gate — groups off unless explicitly opted in.
      if (!botMaySend(config, input)) return

      // 1b. Access-control gate — drop senders the channel's access mode
      //     excludes (allowlist / group-members) before any work, logging the
      //     reason so a drop is diagnosable (a `lid_unidentifiable` drop means
      //     the sender's number was hidden and no PN mapping was known yet).
      const decision = botAnswerDecision(config, input)
      if (!decision.allowed) {
        console.warn('[whatsapp-bot] access-gate drop', {
          channelId: input.channelId,
          mode: config.accessMode ?? 'allow_all',
          reason: decision.reason,
          isGroup: input.isGroup,
        })
        return
      }

      // 2. Trigger gate. Full-assistant DMs are always answered (Telegram
      //    parity — a direct message to the bot's own number is the trigger).
      //    Groups still require a matching `reply` rule. The legacy lightweight
      //    path keeps the trigger gate for DMs too (no `runAssistant`).
      const triggerGated = input.isGroup || !deps.runAssistant
      if (triggerGated && !(await deps.evalTrigger(input))) return

      // 3. Full-assistant mode — hand off to the real engine. It owns context
      //    assembly, tools, sending, confirmations and session persistence.
      if (deps.runAssistant) {
        await deps.runAssistant(input)
        return
      }

      // 3b. Lightweight persona mode (legacy fallback) — short-term history
      //     always; long-term brain context only in dual mode.
      const history = await deps.getRecentHistory(input.chatJid)
      const brainContext = deps.getBrainContext ? await deps.getBrainContext(input) : ''

      // 4. Persona reply — no brain write; send only on non-empty output.
      const reply = await deps.generateReply({
        persona: config.persona,
        history,
        brainContext,
        input,
      })
      if (!reply.trim()) return
      await deps.send(input.chatJid, reply)
    },
  }
}
