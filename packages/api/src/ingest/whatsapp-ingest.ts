/**
 * WhatsApp group ingest — inbound-relay producer for Pipeline B/C.
 *
 * Read-only Bring-Your-Own-Number: a workspace QR-links a real person's
 * WhatsApp number (companion device). That number is already in team
 * groups. We silently read the messages of ENABLED groups into the brain
 * and never send anything. This is the Slack-ingest use case on WhatsApp,
 * so this file mirrors `slack-webhook-ingest.ts` — the differences are:
 *
 *   1. Fed by the wa-connector inbound relay (the same relay the dormant
 *      responder uses), not a public webhook. The relay carries only a
 *      `channelId`, so we resolve the workspace / connector_instance /
 *      owner here via `resolveChannel`.
 *   2. The Episode is a `channel_window` (per-participant actors), not a
 *      `slack_thread` — attribution is per real sender, never smeared.
 *   3. Default-drop: `DEFAULT_INGEST_RULES.whatsapp` is empty, so a group
 *      is ignored until the owner enables it (which appends a `group_match`
 *      rule). DMs (`@s.whatsapp.net`) are dropped in v1.
 *
 * Routing follows the engine decision (same as Slack):
 *   - `scheduled` → `appendBatchEvent`; the per-group `(rule_id, fires_at)`
 *     batch IS the window. The batch worker compresses it (Phase 2) into a
 *     single `channel_window` Episode. This is the default posture for an
 *     enabled group (avoids per-message extraction cost/noise).
 *   - `realtime` → inline single-message `channel_window` Episode +
 *     Pipeline B. Available for high-signal groups via the enable UI.
 *   - `drop` / no-match → discarded.
 *
 * v1 never sends: this producer performs no tool calls and no replies.
 *
 * See docs/architecture/brain/ingest-pipeline.md → "Source adapters" →
 * WhatsApp and docs/architecture/channels/whatsapp.md.
 *
 * [COMP:api/whatsapp-ingest]
 */

import {
  composeFilters,
  computeNextRun,
  createIngestEngine,
  normalizeWhatsappGroup,
  processEpisode,
  universalFilters,
  whatsappFilterImplementations,
  type AnalyticsLogger,
  type CrmStore,
  type EntityLinksStore,
  type EntityStore,
  type FilterRegistry,
  type IngestEngine,
  type IngestEvent,
  type IngestRule,
  type LLMProvider,
  type MemoryStore,
  type PipelineBEpisode,
  type UsageStore,
  type PlaceholderResolver,
  type SourceKind,
  type TaskStore,
  type WhatsappGroupWindow,
} from '@use-brian/core'
import { appendBatchEvent } from '../db/pending-ingest-batches-store.js'
import type { DbEpisodesStore } from '../db/episodes-store.js'
import type { IngestRuleRow, IngestRulesStore } from '../db/ingest-rules-store.js'
import { resolveIngestPlaceholders } from './placeholder-resolver.js'

// ── Public surface ──────────────────────────────────────────────

/**
 * One inbound WhatsApp message handed to the ingestor by the relay tap.
 * Only the fields the ingest path reads are declared; the wa-connector
 * payload carries more.
 */
export type WhatsappIngestInput = {
  /** Workspace `channels.id` for this WhatsApp number (relay payload). */
  channelId: string
  /** Chat JID — `<id>@g.us` for a group, `<phone>@s.whatsapp.net` for a DM. */
  chatJid: string
  /** Group subject / display name, when the relay supplied one. */
  chatSubject?: string
  /** Real sender JID (`<phone>@s.whatsapp.net`). */
  senderJid: string
  /** Sender push name, when known. */
  senderName?: string
  /** WhatsApp message id. */
  messageId: string
  /** Message body. */
  text: string
  /** Epoch milliseconds. */
  timestamp: number
  /** True for `@g.us` chats. DMs are dropped in v1. */
  isGroup: boolean
  /** True when the author is a bot / our own connected number — skipped. */
  isBot?: boolean
}

/** Resolved per-channel context the relay payload doesn't carry. */
export type WhatsappChannelContext = {
  workspaceId: string
  /** Paired `connector_instance.id` keying the rule + batch lookup. */
  connectorInstanceId: string
  /**
   * The WhatsApp `channel_integrations.id`. Carries the connect-time number
   * JID and the `seenChats` group inventory the enable UI reads — keyed here
   * so the intake can record every observed group (the eligibility signal).
   */
  channelIntegrationId: string
  /** Billing party + extraction attribution (workspace owner). */
  userId: string
  /** Workspace primary assistant, when one exists; else null. */
  assistantId: string | null
}

export type WhatsappIngestor = {
  /**
   * Route one inbound WhatsApp message through the connector instance's
   * DB-backed rules. Resolves to:
   *   - `{ episodeId }` when realtime extraction ran,
   *   - `null` for drop matches, scheduled enqueues, DMs, bot traffic,
   *     empty text, an un-ingest-capable / unprovisioned channel, an
   *     un-enabled group (no matching rule), or any no-match outcome.
   */
  ingest: (input: WhatsappIngestInput) => Promise<{ episodeId: string } | null>
  /** Generic resolved realtime extraction seam used by injected host concerns. */
  ingestResolved: (
    input: WhatsappIngestInput,
    context: WhatsappChannelContext,
    sensitivity?: 'public' | 'internal' | 'confidential',
  ) => Promise<{ episodeId: string } | null>
  /**
   * True when `channelId` is a Bring-Your-Own-Number ingest channel
   * (`'ingest'`-capable + a provisioned connector instance). The inbound
   * relay uses this to keep the responder dormant for a read-only number:
   * a BYON channel ingests groups and drops everything else, sending
   * nothing — not even a "please link" reply. Resolves `false` for the
   * legacy shared responder channel and any unknown channel, so those
   * fall through to the responder unchanged.
   */
  isIngestChannel: (channelId: string) => Promise<boolean>
}

export type WhatsappIngestorDeps = {
  provider: LLMProvider
  /** Extraction model id — Standard tier per model-routing.md. */
  model: string
  crm: CrmStore
  entities: EntityStore
  entityLinks: EntityLinksStore
  memories: MemoryStore
  /**
   * Task store for the extraction's actionable-item slot. Pipeline B writes
   * each extracted task via `TaskStore.create` (one DB write per item — the
   * deterministic, code-driven "operation" the LLM only decides on). When
   * omitted, extracted tasks are dropped with a `console.warn` and only
   * entities + memories land. Wire it so an ingested commitment
   * ("mike ships feat A by sunday") becomes a ticket.
   */
  tasks?: TaskStore
  episodes: DbEpisodesStore
  /** DB rules for the paired connector_instance — loaded per event. */
  ingestRulesStore: IngestRulesStore
  /**
   * Resolve a relay `channelId` to its workspace / CI / owner. Returns
   * `null` when the channel isn't ingest-capable or isn't provisioned —
   * the message is then dropped. Inject a stub in tests.
   */
  resolveChannel: (channelId: string) => Promise<WhatsappChannelContext | null>
  /**
   * Record an observed group into the integration's `seenChats` inventory —
   * the connected-number-presence eligibility signal: a group becomes
   * enable-able in Studio once we've seen the connected number active in it.
   * Called for EVERY group message (before the default-drop), so un-enabled
   * groups still surface in the enable UI. Best-effort; injected so the
   * ingestor stays decoupled from the channel-integration store. Default: no-op.
   */
  recordSeenGroup?: (input: {
    channelIntegrationId: string
    chatJid: string
    subject?: string
  }) => Promise<void>
  classifierModel?: string | null
  analytics?: AnalyticsLogger
  isUserBlockedForAssistant?: (assistantId: string, userId: string) => Promise<boolean>
  /** Defaults to the workspace-scoped placeholder resolver. */
  resolvePlaceholders?: PlaceholderResolver
  /** Test seam — defaults to core `processEpisode`. */
  runExtraction?: typeof processEpisode
  /** Test seam — defaults to `appendBatchEvent`. */
  appendBatchEvent?: typeof appendBatchEvent
  /** Test seam — defaults to `() => new Date()`. */
  now?: () => Date
  /** Usage recorder — overhead:extraction attribution (see PipelineBDeps.usage). */
  usageStore?: UsageStore
  /** Bulk-ingest surcharge hook — see PipelineBDeps.ingestCharge (0.5cr item, platform-priced, idempotent per episode). */
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
  /** Hosted batch worker available. False executes scheduled matches realtime. */
  scheduledBatching?: boolean
}

// ── Engine wiring ───────────────────────────────────────────────

/**
 * Adapt the whatsapp adapter's `(WhatsappGroupWindow, params) → boolean`
 * filters onto the engine's `(IngestEvent, params) → boolean` shape. The
 * intake builds `event.normalized` as a superset of `WhatsappGroupWindow`,
 * so the cast is sound. `sender_match` intentionally shadows the universal
 * variant with the window-aware one.
 */
const whatsappEngineFilters: FilterRegistry = Object.freeze({
  group_match: (event, params) =>
    whatsappFilterImplementations.group_match(asWindow(event), params as never),
  sender_match: (event, params) =>
    whatsappFilterImplementations.sender_match(asWindow(event), params as never),
  is_dm: (event, params) =>
    whatsappFilterImplementations.is_dm(asWindow(event), params as never),
})

function asWindow(event: IngestEvent): WhatsappGroupWindow {
  return event.normalized as unknown as WhatsappGroupWindow
}

/** DB `IngestRuleRow` → engine `IngestRule`. */
function toEngineRule(row: IngestRuleRow): IngestRule {
  return {
    id: row.id,
    connector_instance_id: row.connectorInstanceId,
    source: row.source,
    rule_order: row.ruleOrder,
    filter_type: row.filterType,
    filter_params: row.filterParams,
    // 'reply' rules (bot triggers) are filtered out before this maps into the
    // core engine, whose RoutingMode union is narrow — the cast is sound.
    routing_mode: row.routingMode as IngestRule['routing_mode'],
    routing_schedule: row.routingSchedule,
    routing_timezone: row.routingTimezone,
    alert: row.alert,
    episode_sensitivity: row.episodeSensitivity,
  }
}

/**
 * Build a routing-only engine for one CI's already-loaded rules. Pipeline
 * B + batch ports are inert — the ingestor handles realtime inline and
 * writes scheduled batches itself (same pattern as the Slack ingestor).
 */
export function buildWhatsappIngestEngine(
  rules: IngestRuleRow[],
  resolvePlaceholders: PlaceholderResolver = resolveIngestPlaceholders,
): IngestEngine {
  // The listener ignores 'reply' rules — those are bot triggers (migration 283)
  // evaluated by the BotHandler, not the ingest path. Keeping them on one shared
  // rule list (decision: reuse ingest_rules) means the two passes filter to
  // their own modes so they stay decoupled.
  const engineRules = rules.filter((r) => r.routingMode !== 'reply').map(toEngineRule)
  return createIngestEngine({
    rules: { listByConnectorInstance: async () => engineRules },
    filters: composeFilters(universalFilters, whatsappEngineFilters),
    batches: { appendEvent: async () => {} },
    pipelineB: { process: async () => ({ episodeId: null }) },
    resolvePlaceholders,
  })
}

/**
 * Build the BotHandler's trigger evaluator from a CI's rules — the bot's half
 * of the shared rule list. Reuses the ingest engine + the same filter registry
 * (`is_mention` / `keyword_match` / `is_dm` / `always`): it keeps only the
 * `routing_mode='reply'` rules and maps them to `realtime` so a filter match
 * yields a matched decision. Returns a predicate the BotHandler calls as its
 * trigger gate; `true` means a reply rule matched this message.
 *
 * Symmetric with `buildWhatsappIngestEngine` (which drops reply rules), so the
 * listener and bot evaluate disjoint subsets of one list and never interfere.
 */
export function buildWhatsappBotTrigger(
  rules: IngestRuleRow[],
  ctx: { workspaceId: string; connectorInstanceId: string },
  resolvePlaceholders: PlaceholderResolver = resolveIngestPlaceholders,
): (input: WhatsappIngestInput) => Promise<boolean> {
  const replyRules = rules
    .filter((r) => r.routingMode === 'reply')
    // Map to 'realtime' so a filter match surfaces as a matched engine decision;
    // the rule set is exclusively reply rules, so any match IS a bot trigger.
    .map((r) => ({ ...toEngineRule(r), routing_mode: 'realtime' as IngestRule['routing_mode'] }))

  const engine = createIngestEngine({
    rules: { listByConnectorInstance: async () => replyRules },
    filters: composeFilters(universalFilters, whatsappEngineFilters),
    batches: { appendEvent: async () => {} },
    pipelineB: { process: async () => ({ episodeId: null }) },
    resolvePlaceholders,
  })

  return async (input: WhatsappIngestInput): Promise<boolean> => {
    if (replyRules.length === 0) return false
    const window: WhatsappGroupWindow = {
      chat_jid: input.chatJid,
      subject: input.chatSubject,
      messages: [
        {
          message_id: input.messageId,
          sender_jid: input.senderJid,
          sender_name: input.senderName,
          text: input.text,
          timestamp: input.timestamp,
          is_bot: false,
        },
      ],
    }
    const decision = await engine.ingest(buildIngestEvent(window, input), {
      workspace_id: ctx.workspaceId,
      connector_instance_id: ctx.connectorInstanceId,
    })
    return decision.matched && decision.rule_id !== null
  }
}

// ── Event shaping ───────────────────────────────────────────────

const WHATSAPP_SOURCE_KIND: SourceKind = 'channel_window'
const CONTENT_REF_MAX_CHARS = 16_000

/**
 * Build the `IngestEvent` the engine sees. `normalized` carries the
 * `WhatsappGroupWindow` substrate (whatsapp filters cast back to it) PLUS
 * the universal-filter substrate (`text`, `actor_id`, `sender`).
 */
function buildIngestEvent(
  window: WhatsappGroupWindow,
  input: WhatsappIngestInput,
): IngestEvent {
  return {
    source: 'whatsapp',
    normalized: {
      // WhatsappGroupWindow substrate (whatsapp filters cast back to this).
      chat_jid: window.chat_jid,
      subject: window.subject,
      messages: window.messages,
      // Universal-filter substrate.
      text: input.text,
      actor_id: input.senderJid,
      sender: input.senderJid,
      mentions: [],
      user_flags: [],
    },
  }
}

// ── Factory ─────────────────────────────────────────────────────

export function createWhatsappIngestor(
  deps: WhatsappIngestorDeps,
): WhatsappIngestor {
  const runExtraction = deps.runExtraction ?? processEpisode
  const resolvePlaceholders = deps.resolvePlaceholders ?? resolveIngestPlaceholders
  const appendEvent = deps.appendBatchEvent ?? appendBatchEvent
  const now = deps.now ?? (() => new Date())

  /** Build the single-message group window the engine + Episode share. */
  function buildWindow(input: WhatsappIngestInput, text: string): WhatsappGroupWindow {
    return {
      chat_jid: input.chatJid,
      subject: input.chatSubject,
      messages: [
        {
          message_id: input.messageId,
          sender_jid: input.senderJid,
          sender_name: input.senderName,
          text,
          timestamp: input.timestamp,
          is_bot: false,
        },
      ],
    }
  }

  /**
   * Materialize one realtime single-message `channel_window` Episode and run
   * Pipeline B extraction over it. Shared by the BYON realtime branch and the
   * official-bot per-group path — the caller supplies the attribution `ctx`
   * (BYON: the workspace owner; official bot: the adder via the binding).
   */
  async function runRealtimeEpisode(
    ctx: WhatsappChannelContext,
    input: WhatsappIngestInput,
    text: string,
    ruleSensitivity: 'public' | 'internal' | 'confidential',
  ): Promise<{ episodeId: string }> {
    const window = buildWindow(input, text)
    const envelope = normalizeWhatsappGroup(window, {
      workspace_id: ctx.workspaceId,
      user_id: ctx.userId,
      assistant_id: ctx.assistantId,
      created_by_user_id: ctx.userId,
      created_by_assistant_id: ctx.assistantId,
    })

    // RuleEpisodeSensitivity uses the 3-value tier; the Episode row uses the
    // 4-value tier. `confidential` collapses to `private` (same mapping as the
    // Slack realtime path).
    const episodeRowSensitivity: 'public' | 'internal' | 'private' =
      ruleSensitivity === 'confidential' ? 'private' : ruleSensitivity

    // A single inbound message is too small to be worth a remote re-fetch —
    // embed it inline, attributed with the sender name so extraction lands the
    // fact on the right person.
    const content = `${input.senderName ?? input.senderJid}: ${text}`.slice(
      0,
      CONTENT_REF_MAX_CHARS,
    )

    const episode = await deps.episodes.createEpisode(ctx.userId, {
      sourceKind: WHATSAPP_SOURCE_KIND,
      sourceRef: envelope.source_ref,
      occurredAt: envelope.occurred_at,
      workspaceId: envelope.workspace_id,
      userId: envelope.user_id,
      assistantId: envelope.assistant_id,
      createdByUserId: envelope.created_by_user_id,
      createdByAssistantId: envelope.created_by_assistant_id,
      sensitivity: episodeRowSensitivity,
      contentRef: { kind: 'manual_paste', text: content },
      status: 'open',
    })

    const pipelineEpisode: PipelineBEpisode = {
      id: episode.id,
      sourceKind: episode.sourceKind as SourceKind,
      occurredAt: episode.occurredAt,
      sensitivity: ruleSensitivity,
      workspaceId: episode.workspaceId,
      userId: episode.userId,
      assistantId: episode.assistantId,
      createdByUserId: episode.createdByUserId,
      createdByAssistantId: episode.createdByAssistantId,
    }

    await runExtraction(pipelineEpisode, content, {
      provider: deps.provider,
      model: deps.model,
      crm: deps.crm,
      entities: deps.entities,
      entityLinks: deps.entityLinks,
      memories: deps.memories,
      tasks: deps.tasks,
      episodes: deps.episodes,
      classifierModel: deps.classifierModel,
      analytics: deps.analytics,
      isUserBlockedForAssistant: deps.isUserBlockedForAssistant,
      usage: deps.usageStore,
      ingestCharge: deps.ingestCharge,
    })

    return { episodeId: episode.id }
  }

  return {
    async isIngestChannel(channelId: string) {
      // A channel resolves iff it's `'ingest'`-capable + provisioned — i.e.
      // a BYON channel. Reuses the same resolver the ingest path gates on.
      return (await deps.resolveChannel(channelId)) !== null
    },
    async ingest(input: WhatsappIngestInput) {
      // Bot / own-number traffic doesn't extract — bots aren't people.
      if (input.isBot) return null
      // DMs are off in v1 — this is a team-group feature. Drop anything
      // that isn't a group, belt-and-suspenders against the chat JID too.
      if (!input.isGroup || input.chatJid.endsWith('@s.whatsapp.net')) return null
      const text = input.text.trim()
      if (!text) return null

      // Resolve the workspace / CI / owner from the relay channelId. A
      // channel without the `ingest` capability or without a provisioned
      // CI returns null → drop.
      const ctx = await deps.resolveChannel(input.channelId)
      if (!ctx) return null

      // Record the group into seenChats BEFORE the default-drop — the
      // connected-number-presence eligibility signal. An un-enabled group
      // the number is in must still surface in the enable UI, so this runs
      // even when no rule matches below. Best-effort: never block ingest.
      if (deps.recordSeenGroup) {
        try {
          await deps.recordSeenGroup({
            channelIntegrationId: ctx.channelIntegrationId,
            chatJid: input.chatJid,
            subject: input.chatSubject,
          })
        } catch (err) {
          console.error('[whatsapp-ingest] recordSeenGroup failed:', err)
        }
      }

      const window = buildWindow(input, text)

      // Load DB-backed rules for this connector instance. System-level —
      // the relay holds no acting user. Empty (default-drop) → the group
      // hasn't been enabled; ignore it.
      const rules = await deps.ingestRulesStore.listByConnectorInstanceSystem(
        ctx.connectorInstanceId,
      )
      if (rules.length === 0) return null

      const engine = buildWhatsappIngestEngine(rules, resolvePlaceholders)
      const event = buildIngestEvent(window, input)
      const decision = await engine.ingest(event, {
        workspace_id: ctx.workspaceId,
        connector_instance_id: ctx.connectorInstanceId,
      })

      if (!decision.matched || decision.rule_id === null) return null
      if (decision.routing_mode === 'drop') return null

      if (decision.routing_mode === 'scheduled' && deps.scheduledBatching) {
        const firesAt = decision.schedule
          ? computeNextRun(
              { type: 'cron', expression: decision.schedule },
              decision.timezone || 'UTC',
              now(),
            )
          : now()
        await appendEvent({
          workspaceId: ctx.workspaceId,
          ruleId: decision.rule_id,
          source: 'whatsapp',
          firesAt,
          event,
          episodeSensitivity: decision.episode_sensitivity,
        })
        return null
      }

      // realtime — inline single-message `channel_window` Episode.
      return runRealtimeEpisode(ctx, input, text, decision.episode_sensitivity ?? 'internal')
    },

    async ingestResolved(input, context, sensitivity = 'internal') {
      if (input.isBot) return null
      if (!input.isGroup || input.chatJid.endsWith('@s.whatsapp.net')) return null
      const text = input.text.trim()
      if (!text) return null
      return runRealtimeEpisode(context, input, text, sensitivity)
    },
  }
}
