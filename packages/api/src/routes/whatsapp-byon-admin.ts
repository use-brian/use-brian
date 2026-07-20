/**
 * WhatsApp read-only ingest — workspace connect + group enable control plane.
 *
 * The Studio → Ingest UI drives this surface for the Bring-Your-Own-Number
 * group source (the assistant silently reads enabled team groups into the
 * brain and never sends — see docs/architecture/channels/whatsapp.md).
 * It is distinct from the dormant, assistant-scoped responder connect proxy
 * in `integrations.ts` (STALE): this one is workspace-scoped, provisions an
 * `['ingest']`-only channel, and pairs it with a `connector_instance`.
 *
 * Routes (all workspace-scoped, owner/admin gated):
 *   - `POST /workspaces/:workspaceId/whatsapp/connect` — SSE QR pairing.
 *     Provisions a single ingest-only WhatsApp channel (one per workspace),
 *     proxies the wa-connector `/connect/:channelId` stream so the browser
 *     never talks to the internal connector, and on the `connected` event
 *     upserts the integration (connected number) + ensures the CI.
 *   - `GET  /workspaces/:workspaceId/whatsapp` — connection status + the
 *     observed-group inventory (`seenChats`) with each group's enable state.
 *   - `POST /workspaces/:workspaceId/whatsapp/groups/enable` — eligibility-
 *     gated `group_match` rule write (realtime or weekday-digest scheduled).
 *   - `POST /workspaces/:workspaceId/whatsapp/groups/disable` — remove it.
 *
 * Eligibility (locked v1 model): a group is enable-able only once it appears
 * in `seenChats` — i.e. the connected number has been observed active in it
 * (recorded at intake by `recordSeenWhatsappGroup`). No wa-connector roster
 * endpoint exists, so the observed set IS the eligible set.
 *
 * [COMP:api/whatsapp-ingest-admin]
 */

import { Router } from 'express'
import { query } from '../db/client.js'
import { recordRosteredWhatsappGroups } from '../ingest/whatsapp-seen-groups.js'
import { normalizeWhatsappNumber } from './whatsapp-bot-handler.js'
import {
  findOrCreateChannelForWorkspaceConnect,
  updateChannel,
} from '../db/channels-store.js'
import type {
  ChannelIntegration,
  ChannelIntegrationStore,
} from '../db/channel-integrations.js'
import type { IngestRuleEditorStore, IngestRuleSummary } from '@use-brian/core'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { ensureWhatsappConnectorInstance } from '../ingest/whatsapp-connector-instance.js'

export type WhatsappIngestAdminOptions = {
  workspaceStore: WorkspaceStore
  integrationStore: ChannelIntegrationStore
  ruleEditor: IngestRuleEditorStore
  waConnectorUrl?: string
  waConnectorSecret?: string
  /** Whether a worker drains pending_ingest_batches. OSS defaults to realtime. */
  scheduledBatching?: boolean
}

/** Weekday 9am digest — same default cadence as the Slack scheduled catchall. */
const DIGEST_SCHEDULE = '0 9 * * 1-5'
const GROUP_FILTER = 'group_match'

/** Access modes the WhatsApp bot surface offers. */
const WA_ACCESS_MODES = ['allow_all', 'allowlist', 'blocklist', 'group_members'] as const
type WaAccessMode = (typeof WA_ACCESS_MODES)[number]

/** Normalize a list of typed numbers to phone digits: dedupe, drop blanks, cap at 100. */
function normalizeNumbers(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return Array.from(
    new Set(
      input
        .filter((n): n is string => typeof n === 'string')
        .map((n) => normalizeWhatsappNumber(n))
        .filter((n): n is string => n !== null),
    ),
  ).slice(0, 100)
}

/** Read the stored access mode, coercing any non-WhatsApp value to `allow_all`. */
function readWaAccessMode(integration: ChannelIntegration | null): WaAccessMode {
  const m = integration?.config?.userAccessMode
  return m && (WA_ACCESS_MODES as readonly string[]).includes(m) ? (m as WaAccessMode) : 'allow_all'
}

type GroupDto = {
  chatJid: string
  title: string | null
  enabled: boolean
  routing: 'realtime' | 'scheduled' | null
  ruleId: string | null
}

/** The `group_match` rule whose `values` contains `chatJid`, if any. */
function findGroupRule(rules: IngestRuleSummary[], chatJid: string): IngestRuleSummary | null {
  for (const r of rules) {
    if (r.filterType !== GROUP_FILTER) continue
    const values = (r.filterParams as { values?: unknown }).values
    if (Array.isArray(values) && values.includes(chatJid)) return r
  }
  return null
}

export function whatsappIngestAdminRoutes(opts: WhatsappIngestAdminOptions): Router {
  const router = Router()
  const { workspaceStore, integrationStore, ruleEditor } = opts

  /** Owner/admin gate. Returns the role, or null after writing a 401/403. */
  async function requireAdmin(
    req: { userId?: string; params: { workspaceId: string } },
    res: import('express').Response,
  ): Promise<'owner' | 'admin' | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const role = await workspaceStore.getRole(userId, req.params.workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Workspace owner or admin required' })
      return null
    }
    return role
  }

  /** The workspace's single WhatsApp integration, or null. */
  async function findWhatsappIntegration(
    actingUserId: string,
    workspaceId: string,
  ): Promise<ChannelIntegration | null> {
    const list = await integrationStore.listForWorkspace(actingUserId, workspaceId)
    return list.find((i) => i.channelType === 'whatsapp') ?? null
  }

  /**
   * The workspace's WhatsApp `connector_instance` id, or null.
   *
   * Resolved from the channel's integration (`channel_integrations.
   * connector_instance_id`, surfaced as `integration.connectorInstanceId`) —
   * the **same** id the inbound ingestor uses (`createWhatsappIngestor.
   * resolveChannel`). This is load-bearing: a re-pair can leave several
   * WhatsApp `connector_instance` rows for one workspace, and picking
   * `listConnectorInstances()[0]` could return a stale one, stranding
   * enabled-group `ingest_rules` on a CI the ingestor never reads — every
   * inbound message then silently default-drops while the UI still shows the
   * group "enabled". Binding both paths to the live integration's CI keeps
   * enable/UI/ingest in lockstep.
   */
  async function findConnectorInstanceId(
    actingUserId: string,
    workspaceId: string,
  ): Promise<string | null> {
    const integration = await findWhatsappIntegration(actingUserId, workspaceId)
    return integration?.connectorInstanceId ?? null
  }

  /**
   * Live group roster from the connector — every group the connected number
   * participates in (Baileys `groupFetchAllParticipating`). Empty on any
   * failure (socket down, connector unconfigured); the caller falls back to the
   * observed-group inventory so the list still works mid-reconnect.
   */
  async function fetchGroupRoster(
    channelId: string,
  ): Promise<{ jid: string; subject: string }[]> {
    if (!opts.waConnectorUrl || !opts.waConnectorSecret) return []
    try {
      const r = await fetch(`${opts.waConnectorUrl}/groups/${channelId}`, {
        headers: { 'X-Connector-Secret': opts.waConnectorSecret },
      })
      if (!r.ok) return []
      const data = (await r.json()) as { groups?: { jid: string; subject: string }[] }
      return data.groups ?? []
    } catch {
      return []
    }
  }

  // ── GET status + group inventory ────────────────────────────────
  router.get<{ workspaceId: string }>('/workspaces/:workspaceId/whatsapp', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const role = await workspaceStore.getRole(userId, req.params.workspaceId)
    if (!role) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }

    const integration = await findWhatsappIntegration(userId, req.params.workspaceId)
    if (!integration) {
      res.json({ connected: false, connectedNumber: null, groups: [] })
      return
    }

    const connectorInstanceId = await findConnectorInstanceId(userId, req.params.workspaceId)
    const rules = connectorInstanceId
      ? await ruleEditor.listRules(userId, connectorInstanceId)
      : []
    // Prefer the live roster (every group the number is in, shown immediately);
    // union in any observed-but-not-rostered group as a fallback (e.g. while the
    // socket is reconnecting and the roster fetch returns empty).
    const roster = await fetchGroupRoster(integration.channelId)
    // Durably fold the roster into seenChats so the inventory only grows: a
    // later flaky roster fetch (returns [] on socket churn) can no longer
    // collapse the list — which previously made the search box and most groups
    // vanish right after enabling one. This response already unions the live
    // roster, so the persist is for the NEXT fetch's stability. Best-effort;
    // never blocks the response.
    if (roster.length > 0) {
      await recordRosteredWhatsappGroups(integrationStore, integration.id, roster).catch(
        (err) => console.error('[whatsapp-ingest-admin] roster persist failed:', err),
      )
    }
    const seen = integration.config?.seenChats ?? []
    const byJid = new Map<string, { chatJid: string; title: string | null }>()
    for (const g of roster) byJid.set(g.jid, { chatJid: g.jid, title: g.subject || null })
    for (const c of seen) {
      if (!byJid.has(c.chatId)) byJid.set(c.chatId, { chatJid: c.chatId, title: c.chatTitle })
    }
    const groups: GroupDto[] = [...byJid.values()].map((g) => {
      const rule = findGroupRule(rules, g.chatJid)
      return {
        chatJid: g.chatJid,
        title: g.title,
        enabled: rule !== null,
        routing: rule ? (rule.routingMode === 'realtime' ? 'realtime' : 'scheduled') : null,
        ruleId: rule?.id ?? null,
      }
    })

    // Order so the groups that matter surface first (the UI caps the initial
    // render): enabled groups, then the ones the number recently received
    // messages in (seenChats `lastSeenAt`, the only recency signal a companion
    // device gives us), then the rest of the roster.
    const lastSeen = new Map<string, string>()
    for (const c of seen) if (c.lastSeenAt) lastSeen.set(c.chatId, c.lastSeenAt)
    groups.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      const la = lastSeen.get(a.chatJid) ?? ''
      const lb = lastSeen.get(b.chatJid) ?? ''
      if (la !== lb) return lb.localeCompare(la) // most-recent first
      return (a.title ?? '').localeCompare(b.title ?? '')
    })

    // Connected number lives on the credentials blob (display-only); the
    // public integration row carries `teamName`, which we seed to it.
    // `connected` tracks the integration status: the wa-connector flips it to
    // `'revoked'` via `/internal/whatsapp/disconnected` when WhatsApp logs the
    // linked device out, and a reconnect re-activates it (connect upsert).
    res.json({
      connected: integration.status === 'active',
      channelId: integration.channelId,
      connectorInstanceId,
      connectedNumber: integration.teamName ?? null,
      groups,
    })
  })

  // ── POST connect (SSE QR pairing) ───────────────────────────────
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/connect',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const { workspaceId } = req.params

      if (!opts.waConnectorUrl || !opts.waConnectorSecret) {
        res.status(503).json({ error: 'WhatsApp connector not configured' })
        return
      }

      // One WhatsApp channel per workspace: reuse an existing one, else
      // create an INGEST-ONLY channel (responder capabilities stay off so
      // the dormant chat path can never fire for a read-only number).
      let channelId: string
      try {
        const existing = await query<{ id: string }>(
          `SELECT id FROM channels WHERE workspace_id = $1 AND channel_type = 'whatsapp' LIMIT 1`,
          [workspaceId],
        )
        if (existing.rows[0]) {
          channelId = existing.rows[0].id
        } else {
          const provisioned = await findOrCreateChannelForWorkspaceConnect({
            workspaceId,
            channelType: 'whatsapp',
            displayName: 'WhatsApp (ingest)',
            enabledCapabilities: ['ingest'],
          })
          channelId = provisioned.channelId
        }
      } catch (err) {
        console.error('[whatsapp-ingest-admin] channel provisioning failed:', err)
        res.status(500).json({ error: 'Failed to provision channel' })
        return
      }

      let upstream: Response
      try {
        // `backend=db`: BYON ingest creds persist to Postgres (`wa_auth_state`),
        // not GCS. Official responder channels (integrations.ts) omit it and
        // default to GCS. See docs/architecture/channels/whatsapp.md.
        upstream = await fetch(`${opts.waConnectorUrl}/connect/${channelId}?backend=db`, {
          method: 'POST',
          headers: { 'X-Connector-Secret': opts.waConnectorSecret },
        })
      } catch (err) {
        console.error('[whatsapp-ingest-admin] connect proxy failed:', err)
        res.status(502).json({ error: 'Failed to reach WhatsApp connector' })
        return
      }
      if (!upstream.ok || !upstream.body) {
        res.status(502).json({ error: 'Failed to connect to WhatsApp connector' })
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        // no-transform: compressing proxies otherwise buffer SSE to one chunk.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })

      const reader = upstream.body.getReader()
      const decoder = new TextDecoder()

      const onConnected = async (phoneNumber: string) => {
        // Pair the channel with an integration (connected number) + CI so
        // the inbound relay's resolveChannel resolves it. Idempotent on
        // re-connect of the same number.
        const integration = await integrationStore.upsert({
          channelId,
          channelType: 'whatsapp',
          teamId: null,
          teamName: phoneNumber,
          botUserId: null,
          botUsername: null,
          credentials: { phone_number: phoneNumber },
          actingUserId: userId,
        })
        await ensureWhatsappConnectorInstance({
          channelIntegrationId: integration.id,
          actingUserId: userId,
        })
        await updateChannel(userId, channelId, { displayName: `WhatsApp ${phoneNumber}` }).catch(
          () => {},
        )
      }

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          res.write(chunk)
          if (chunk.includes('event: connected')) {
            try {
              const m = chunk.match(/event: connected\ndata: ({.*})/)
              if (m) {
                const { phoneNumber } = JSON.parse(m[1]) as { phoneNumber?: string }
                if (phoneNumber) await onConnected(phoneNumber)
              }
            } catch (e) {
              console.error('[whatsapp-ingest-admin] connect finalize failed (non-fatal):', e)
            }
          }
        }
        if (!res.writableEnded) res.end()
      }

      req.on('close', () => {
        reader.cancel().catch(() => {})
      })
      pump().catch((err) => {
        console.error('[whatsapp-ingest-admin] connect pump error:', err)
        if (!res.writableEnded) res.end()
      })
    },
  )

  // ── POST enable a group ─────────────────────────────────────────
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/groups/enable',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const { workspaceId } = req.params
      const { chatJid, routing } = req.body as {
        chatJid?: string
        routing?: 'realtime' | 'scheduled'
      }
      if (!chatJid || (routing !== 'realtime' && routing !== 'scheduled')) {
        res.status(400).json({ error: 'chatJid and routing (realtime|scheduled) are required' })
        return
      }

      const integration = await findWhatsappIntegration(userId, workspaceId)
      const connectorInstanceId = await findConnectorInstanceId(userId, workspaceId)
      if (!integration || !connectorInstanceId) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }

      // Eligibility: the group must be one the connected number is actually in —
      // either present in the live roster or previously observed (seenChats).
      const seen = integration.config?.seenChats ?? []
      const roster = await fetchGroupRoster(integration.channelId)
      const eligible =
        roster.some((g) => g.jid === chatJid) || seen.some((c) => c.chatId === chatJid)
      if (!eligible) {
        res.status(403).json({ error: 'group_not_eligible' })
        return
      }

      const rules = await ruleEditor.listRules(userId, connectorInstanceId)
      const existing = findGroupRule(rules, chatJid)

      // Hosted has a batch worker and keeps weekday digests. OSS executes
      // realtime so it never creates pending rows with no drainer.
      const effectiveRouting = opts.scheduledBatching ? 'scheduled' as const : 'realtime' as const
      const routingSchedule = opts.scheduledBatching ? DIGEST_SCHEDULE : null

      if (existing) {
        await ruleEditor.updateRule(userId, {
          ruleId: existing.id,
          patch: { routingMode: effectiveRouting, routingSchedule },
        })
        res.json({ chatJid, enabled: true, routing: effectiveRouting, ruleId: existing.id })
        return
      }

      const created = await ruleEditor.addRule(userId, {
        connectorInstanceId,
        filterType: GROUP_FILTER,
        filterParams: { values: [chatJid] },
        routingMode: effectiveRouting,
        routingSchedule,
        routingTimezone: 'UTC',
      })
      res.status(201).json({ chatJid, enabled: true, routing: effectiveRouting, ruleId: created.id })
    },
  )

  // ── POST disable a group ────────────────────────────────────────
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/groups/disable',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const { workspaceId } = req.params
      const { chatJid } = req.body as { chatJid?: string }
      if (!chatJid) {
        res.status(400).json({ error: 'chatJid is required' })
        return
      }

      const connectorInstanceId = await findConnectorInstanceId(userId, workspaceId)
      if (!connectorInstanceId) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      const rules = await ruleEditor.listRules(userId, connectorInstanceId)
      const existing = findGroupRule(rules, chatJid)
      if (existing) await ruleEditor.deleteRule(userId, existing.id)
      res.json({ chatJid, enabled: false })
    },
  )

  // ── Bot ('chat' capability) config — Phase 6 backend ─────────────
  // Distinct from the read-only listener above: this turns on the trigger-gated
  // persona responder. Bot triggers are `routing_mode='reply'` ingest_rules
  // written directly (not via the ingest ruleEditor, whose core RoutingMode
  // type is narrow), so they never co-mingle with the listener's ingest rules.
  // See docs/architecture/channels/whatsapp.md.

  /** Trigger filters a bot reply rule may use. */
  const BOT_TRIGGER_FILTERS = new Set(['is_mention', 'keyword_match', 'is_dm', 'always'])

  // GET bot config (chat enabled + send scope + reply triggers)
  router.get<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const { workspaceId } = req.params
      const integration = await findWhatsappIntegration(userId, workspaceId)
      const connectorInstanceId = await findConnectorInstanceId(userId, workspaceId)
      if (!integration || !connectorInstanceId) {
        res.json({
          connected: false,
          chatEnabled: false,
          sendScope: 'dm',
          triggers: [],
          accessMode: 'allow_all',
          allowedNumbers: [],
          blockedNumbers: [],
          ackReaction: '',
          groupOptIn: [],
        })
        return
      }
      const chan = await query<{ chatEnabled: boolean; sendScope: string | null }>(
        `SELECT ('chat' = ANY (enabled_capabilities)) AS "chatEnabled",
                whatsapp_bot_send_scope AS "sendScope"
           FROM channels WHERE id = $1`,
        [integration.channelId],
      )
      const triggers = await query<{ id: string; filterType: string; filterParams: unknown }>(
        `SELECT id, filter_type AS "filterType", filter_params AS "filterParams"
           FROM ingest_rules
          WHERE connector_instance_id = $1 AND routing_mode = 'reply'
          ORDER BY rule_order`,
        [connectorInstanceId],
      )
      res.json({
        connected: true,
        chatEnabled: chan.rows[0]?.chatEnabled ?? false,
        sendScope: chan.rows[0]?.sendScope ?? 'dm',
        triggers: triggers.rows,
        accessMode: readWaAccessMode(integration),
        allowedNumbers: integration.config?.allowedUserIds ?? [],
        blockedNumbers: integration.config?.blockedUserIds ?? [],
        ackReaction: integration.config?.ackReaction ?? '',
        groupOptIn: integration.config?.whatsappGroupOptIn ?? [],
      })
    },
  )

  // POST set bot behavior — the acknowledgment reaction (emoji reacted to the
  // inbound when the bot starts) and the per-group reply opt-in (which group
  // chats the bot may answer in when send scope is `dm_and_groups`). Partial:
  // only the provided fields are written.
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot/behavior',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const body = req.body as { ackReaction?: unknown; groupOptIn?: unknown }
      const hasAck = typeof body.ackReaction === 'string'
      const hasGroups = Array.isArray(body.groupOptIn)
      if (!hasAck && !hasGroups) {
        res.status(400).json({ error: 'ackReaction (string) or groupOptIn (array) is required' })
        return
      }
      const ackReaction = hasAck ? (body.ackReaction as string).slice(0, 50) : undefined
      const groupOptIn = hasGroups
        ? Array.from(
            new Set(
              (body.groupOptIn as unknown[]).filter(
                (g): g is string => typeof g === 'string' && g.endsWith('@g.us'),
              ),
            ),
          ).slice(0, 500)
        : undefined
      const integration = await findWhatsappIntegration(userId, req.params.workspaceId)
      if (!integration) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      await integrationStore.mergeConfigSystem(integration.id, (current) => ({
        ...current,
        ...(ackReaction !== undefined ? { ackReaction } : {}),
        ...(groupOptIn !== undefined ? { whatsappGroupOptIn: groupOptIn } : {}),
      }))
      res.json({
        ackReaction: ackReaction ?? integration.config?.ackReaction ?? '',
        groupOptIn: groupOptIn ?? integration.config?.whatsappGroupOptIn ?? [],
      })
    },
  )

  // POST set who the bot may answer (access control — Telegram-parity allowlist).
  // Writes `userAccessMode` + `allowedUserIds` (phone numbers) into the
  // integration config. Modes: 'allow_all' | 'allowlist' | 'group_members'.
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot/access',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const body = req.body as { accessMode?: string; numbers?: unknown; allowedNumbers?: unknown }
      const accessMode = body.accessMode
      if (!accessMode || !(WA_ACCESS_MODES as readonly string[]).includes(accessMode)) {
        res.status(400).json({ error: `accessMode must be one of ${WA_ACCESS_MODES.join(', ')}` })
        return
      }
      // `numbers` is the list for whichever number-mode is active (allowlist →
      // allowed, blocklist → blocked). `allowedNumbers` kept for back-compat.
      const numbers = normalizeNumbers(body.numbers ?? body.allowedNumbers)
      const integration = await findWhatsappIntegration(userId, req.params.workspaceId)
      if (!integration) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      // Write the mode plus only the list it governs, so switching modes never
      // wipes the other list (mirrors the Telegram BYO allow/blocklist storage).
      await integrationStore.mergeConfigSystem(integration.id, (current) => ({
        ...current,
        userAccessMode: accessMode as WaAccessMode,
        ...(accessMode === 'allowlist' ? { allowedUserIds: numbers } : {}),
        ...(accessMode === 'blocklist' ? { blockedUserIds: numbers } : {}),
      }))
      res.json({
        accessMode,
        allowedNumbers: accessMode === 'allowlist' ? numbers : integration.config?.allowedUserIds ?? [],
        blockedNumbers: accessMode === 'blocklist' ? numbers : integration.config?.blockedUserIds ?? [],
      })
    },
  )

  // POST enable the bot (add 'chat' capability + set send scope)
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot/enable',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const { workspaceId } = req.params
      const { sendScope } = req.body as { sendScope?: 'dm' | 'dm_and_groups' }
      if (sendScope !== undefined && sendScope !== 'dm' && sendScope !== 'dm_and_groups') {
        res.status(400).json({ error: 'sendScope must be dm or dm_and_groups' })
        return
      }
      const integration = await findWhatsappIntegration(userId, workspaceId)
      if (!integration) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      await query(
        `UPDATE channels
            SET enabled_capabilities = CASE WHEN 'chat' = ANY (enabled_capabilities)
                                            THEN enabled_capabilities
                                            ELSE array_append(enabled_capabilities, 'chat') END,
                whatsapp_bot_send_scope = $2
          WHERE id = $1`,
        [integration.channelId, sendScope ?? 'dm'],
      )
      res.json({ chatEnabled: true, sendScope: sendScope ?? 'dm' })
    },
  )

  // POST disable the bot (remove 'chat' capability)
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot/disable',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const integration = await findWhatsappIntegration(userId, req.params.workspaceId)
      if (!integration) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      await query(
        `UPDATE channels SET enabled_capabilities = array_remove(enabled_capabilities, 'chat')
          WHERE id = $1`,
        [integration.channelId],
      )
      res.json({ chatEnabled: false })
    },
  )

  // POST add a reply trigger
  router.post<{ workspaceId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot/triggers',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const { filterType, filterParams } = req.body as {
        filterType?: string
        filterParams?: Record<string, unknown>
      }
      if (!filterType || !BOT_TRIGGER_FILTERS.has(filterType)) {
        res.status(400).json({
          error: `filterType must be one of ${[...BOT_TRIGGER_FILTERS].join(', ')}`,
        })
        return
      }
      const connectorInstanceId = await findConnectorInstanceId(userId, req.params.workspaceId)
      if (!connectorInstanceId) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      const created = await query<{ id: string }>(
        `INSERT INTO ingest_rules
           (connector_instance_id, source, rule_order, filter_type, filter_params, routing_mode, routing_timezone)
         VALUES ($1, 'whatsapp',
           (SELECT COALESCE(MAX(rule_order), -1) + 1 FROM ingest_rules WHERE connector_instance_id = $1),
           $2, $3, 'reply', 'UTC')
         RETURNING id`,
        [connectorInstanceId, filterType, JSON.stringify(filterParams ?? {})],
      )
      res.status(201).json({ id: created.rows[0]?.id, filterType, filterParams: filterParams ?? {} })
    },
  )

  // DELETE a reply trigger (scoped to reply rules so it can't touch ingest rules)
  router.delete<{ workspaceId: string; ruleId: string }>(
    '/workspaces/:workspaceId/whatsapp/bot/triggers/:ruleId',
    async (req, res) => {
      const role = await requireAdmin(req as never, res)
      if (!role) return
      const userId = (req as { userId?: string }).userId as string
      const connectorInstanceId = await findConnectorInstanceId(userId, req.params.workspaceId)
      if (!connectorInstanceId) {
        res.status(409).json({ error: 'WhatsApp is not connected for this workspace' })
        return
      }
      await query(
        `DELETE FROM ingest_rules
          WHERE id = $1 AND connector_instance_id = $2 AND routing_mode = 'reply'`,
        [req.params.ruleId, connectorInstanceId],
      )
      res.json({ id: req.params.ruleId, deleted: true })
    },
  )

  return router
}
