/**
 * WhatsApp bot wiring — assembles a `WhatsappBot` (the dispatcher's injected
 * bot seam) from a per-assistant channel.
 *
 * `resolveHandler(input)` resolves the channel's bot context (capability +
 * config), and when the channel is a `'chat'`-capable bot channel, loads its
 * `routing_mode='reply'` rules, builds the trigger evaluator
 * (`buildWhatsappBotTrigger`), and returns a ready `BotHandler` wired to the
 * real LLM / history / send deps. Returns `null` for a non-bot channel so the
 * dispatcher leaves it to the listener and/or the legacy responder.
 *
 * The heavy primitives (channel SQL, session history, the persona LLM call, the
 * wa-connector send) are injected so this assembly is unit-testable and so the
 * platform package never imports `apps/api` infrastructure directly. Real impls
 * are supplied in `apps/api/src/index.ts`.
 *
 * Writes nothing to the brain (decision #1). See
 * docs/architecture/channels/whatsapp.md.
 *
 * [COMP:api/whatsapp-bot-wiring]
 */

import type { WhatsAppHandler } from './whatsapp-dispatcher.js'
import {
  buildWhatsappBotHandler,
  type WhatsappBot,
  type WhatsappBotInput,
} from './whatsapp-bot-handler.js'
import { buildWhatsappBotTrigger } from '../ingest/whatsapp-ingest.js'
import type { IngestRuleRow } from '../db/ingest-rules-store.js'

/** What a resolved `'chat'`-capable bot channel carries. */
export type BotChannelContext = {
  workspaceId: string
  connectorInstanceId: string
  assistantId: string | null
  /** Assistant display name (`processChannelMessage` needs it in full-assistant mode). */
  assistantName: string
  /** Billing / session owner (the per-chat history session is owner-scoped). */
  ownerUserId: string
  /** Persona system prompt — `assistant.systemPrompt`, or null for the default. */
  persona: string | null
  /** `channels.whatsapp_bot_send_scope`; NULL → `'dm'`. */
  sendScope: 'dm' | 'dm_and_groups'
  /** Groups the bot may reply in (DM-default model; groups gated). */
  groupOptIn: string[]
  /**
   * Acknowledgment reaction emoji — reacted to the inbound message when the bot
   * starts working (Telegram/Slack parity). Empty string = none. Consumed by
   * the full-assistant `runAssistant` path in `apps/api`.
   */
  ackReaction?: string
  /**
   * True when the channel is ALSO a listener (`'ingest'` capability) — i.e.
   * dual mode. Only then does the bot query the brain for long-term context
   * (Phase 5); a bot-only channel runs on short-term history alone.
   */
  dual: boolean
  /** Assistant kind + clearance — used to build the brain-read `AccessContext`. */
  assistantKind: 'primary' | 'standard' | 'app'
  assistantClearance: 'public' | 'internal' | 'confidential'
  /**
   * Access-control mode (Telegram-parity allowlist). Omitted → `'allow_all'`.
   * See `WhatsappBotAccessMode` / `botMayAnswer` in whatsapp-bot-handler.ts.
   */
  accessMode?: 'allow_all' | 'allowlist' | 'blocklist' | 'group_members'
  /** Allowed sender numbers (normalized digits) for `accessMode='allowlist'`. */
  allowedNumbers?: string[]
  /** Blocked sender numbers (normalized digits) for `accessMode='blocklist'`. */
  blockedNumbers?: string[]
  /**
   * Cached union of group-participant numbers (normalized digits), for DM gating
   * under `accessMode='group_members'`. Resolved by `resolveBotChannel` (the
   * composition root fetches + caches the connector roster).
   */
  groupMemberNumbers?: string[]
}

export type WhatsappBotWiringDeps = {
  /**
   * Resolve a relay `channelId` to its bot context, or `null` when the channel
   * is not `'chat'`-capable / not provisioned (→ the dispatcher skips the bot).
   */
  resolveBotChannel: (channelId: string) => Promise<BotChannelContext | null>
  /** Load the connector instance's ingest rules (the bot keeps the reply ones). */
  loadRules: (connectorInstanceId: string) => Promise<IngestRuleRow[]>
  /**
   * Short-term thread history for the chat, as prompt text. Per-chat scoped:
   * keyed on `(ctx.assistantId, chatJid)` (one thread per conversation,
   * regardless of speaker). Owner-scoped session via `ctx.ownerUserId`.
   */
  getRecentHistory: (ctx: BotChannelContext, chatJid: string) => Promise<string>
  /** Generate the persona reply (no tools, no brain write). */
  generateReply: (args: {
    persona: string | null
    history: string
    brainContext: string
    input: WhatsappBotInput
  }) => Promise<string>
  /** Send through wa-connector `/send` for this channel's socket. */
  send: (channelId: string, chatJid: string, text: string) => Promise<{ messageId: string }>
  /**
   * Persist the inbound message + the bot's reply into the per-chat session
   * (short-term thread history; decision #1 — NOT a brain write). Called after
   * a successful send so the next message's `getRecentHistory` sees this turn.
   * Best-effort; omit to run the bot stateless.
   */
  recordTurn?: (
    ctx: BotChannelContext,
    input: WhatsappBotInput,
    reply: string,
  ) => Promise<void>
  /**
   * Long-term brain context for dual mode (Phase 5). Omit for bot-only mode.
   * When supplied, it is consulted only when the channel is also a listener
   * (dual) — wiring decides; the handler just receives the resolved string.
   */
  getBrainContext?: (
    ctx: BotChannelContext,
    input: WhatsappBotInput,
  ) => Promise<string>
  /**
   * Full-assistant reply path (BYON bot mode). When supplied, the resolved
   * handler routes the inbound through this callback — wired in `apps/api` to
   * `processChannelMessage` + WhatsApp `ChannelHooks` — instead of the
   * lightweight `generateReply` pipeline. The callback receives the resolved
   * channel context (owner / assistant / workspace) and the inbound, and owns
   * sending, typing, tool confirmations and session persistence. When absent the
   * handler falls back to the lightweight persona reply. See
   * docs/architecture/channels/whatsapp.md → "BYON bot mode".
   */
  runAssistant?: (
    ctx: BotChannelContext,
    input: WhatsappBotInput,
  ) => Promise<void>
  /** An un-triggered group message in full-assistant mode (a room post when bound, D4). */
  postPassive?: (
    ctx: BotChannelContext,
    input: WhatsappBotInput,
  ) => Promise<void>
}

export function createWhatsappBot(deps: WhatsappBotWiringDeps): WhatsappBot {
  return {
    async resolveHandler(input: WhatsappBotInput): Promise<WhatsAppHandler | null> {
      const ctx = await deps.resolveBotChannel(input.channelId)
      if (!ctx) return null

      const rules = await deps.loadRules(ctx.connectorInstanceId)
      const evalTrigger = buildWhatsappBotTrigger(rules, {
        workspaceId: ctx.workspaceId,
        connectorInstanceId: ctx.connectorInstanceId,
      })

      return buildWhatsappBotHandler(
        {
          evalTrigger,
          getRecentHistory: (chatJid) => deps.getRecentHistory(ctx, chatJid),
          generateReply: deps.generateReply,
          // Send, then persist the turn into the per-chat session so the next
          // message has short-term history. Persistence is best-effort and
          // never fails the send.
          send: async (chatJid, text) => {
            const res = await deps.send(input.channelId, chatJid, text)
            if (deps.recordTurn) {
              await deps.recordTurn(ctx, input, text).catch((err) => {
                console.error('[whatsapp-bot] recordTurn failed:', err)
              })
            }
            return res
          },
          // Brain context only when wiring supplied a resolver (dual mode).
          ...(deps.getBrainContext
            ? { getBrainContext: (i: WhatsappBotInput) => deps.getBrainContext!(ctx, i) }
            : {}),
          // Full-assistant mode — route through processChannelMessage (apps/api).
          ...(deps.runAssistant
            ? { runAssistant: (i: WhatsappBotInput) => deps.runAssistant!(ctx, i) }
            : {}),
          ...(deps.postPassive
            ? { postPassive: (i: WhatsappBotInput) => deps.postPassive!(ctx, i) }
            : {}),
        },
        {
          persona: ctx.persona,
          sendScope: ctx.sendScope,
          groupOptIn: ctx.groupOptIn,
          ...(ctx.accessMode ? { accessMode: ctx.accessMode } : {}),
          ...(ctx.allowedNumbers ? { allowedNumbers: ctx.allowedNumbers } : {}),
          ...(ctx.blockedNumbers ? { blockedNumbers: ctx.blockedNumbers } : {}),
          ...(ctx.groupMemberNumbers ? { groupMemberNumbers: ctx.groupMemberNumbers } : {}),
        },
        input,
      )
    },
  }
}
