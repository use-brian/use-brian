/**
 * Public API — third-party integration surface.
 *
 * See docs/architecture/features/public-api.md for the full design.
 * Component tag: [COMP:api/public-api-route].
 *
 * Mounted at `/api/v1`. Authenticated via API keys minted from the
 * assistant's settings page. Each consumer (the third-party service
 * holding the API key) passes their own opaque `externalUserId`;
 * sidanclaw maps that to a Tier 1 (with email) or Tier 2 (without
 * email) shadow user.
 *
 * v1 shape:
 *   - Synchronous JSON, no SSE.
 *   - Base + KB tools only — no MCP, no inter-assistant.
 *   - KB clearance inherits the assistant's `clearance` field — owners
 *     pick the right assistant for the right consumer tier.
 *   - Owner pays via existing usage budget (no per-key cap yet).
 */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  queryLoop,
  buildMemoryContext,
  createMemoryTools,
  calculateCost,
  filterToolsByCapabilities,
  sanitize as sanitizeAnalytics,
  stripUnsignedToolUses,
  modelToCompactionTier,
} from '@sidanclaw/core'
import type {
  LLMProvider,
  Tool,
  MemoryStore,
  UsageStore,
  Message,
  CapabilityStore,
  KnowledgeStoreInterface,
  AnalyticsLogger,
  TokenUsage,
  EpisodicStore,
  SessionStateStore,
  McpSettingsStore,
  GDriveFilesStore,
} from '@sidanclaw/core'
import { runProactiveCompaction } from './proactive-compaction.js'
import { applyMcpInjection, buildUnavailableCapabilitiesPrompt } from './route-helpers.js'
import { getConnectorUserId, getWorkspacePlan, resolveReadCeilingsSystem } from '../db/workspace-store.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import {
  findAssistantById,
  findOrCreateUser,
  findUserByEmail,
  findUserById,
  findUserByAuthProvider,
} from '../db/users.js'
import {
  findOrCreateSession,
  findSessionByChannel,
  addSessionMessage,
  getSessionMessages,
  truncateMessagesFrom,
} from '../db/sessions.js'
import type { ContentBlock, EngineHooks } from '@sidanclaw/core'
import { sanitizeDeliveryText } from '@sidanclaw/shared'
import { billingPartyForAssistant } from '../billing-party.js'
import { resolveModel } from '../model-resolution.js'
import { checkUsageBudget } from './route-helpers.js'
import {
  parseAuthToken,
  verifySecret,
  type ApiKeyStore,
} from '../db/api-key-store.js'
import { query } from '../db/client.js'
import type { ShadowClaimStore } from '../db/shadow-claim-store.js'
import { mergeShadowUser } from '../db/linked-accounts.js'

export type PublicApiRouteOptions = {
  provider: LLMProvider
  /**
   * Base tool map. MCP-discovered tools (mcp_search/mcp_call, granted
   * connectors) and KB tools are added per-request via `applyMcpInjection`
   * — keeps the API channel at parity with `chat.ts`.
   */
  tools: Map<string, Tool>
  systemPrompt: string
  apiKeyStore: ApiKeyStore
  memoryStore: MemoryStore
  usageStore?: UsageStore
  knowledgeStore?: KnowledgeStoreInterface
  capabilityStore: CapabilityStore
  analytics?: AnalyticsLogger
  /**
   * Threaded into `runProactiveCompaction` so the API channel keeps
   * full parity with web chat. Optional — when absent, compaction
   * still runs but episode persistence + session-state housekeeping
   * are no-ops (matches dev/test setups without the full memory stack).
   */
  episodicStore?: EpisodicStore
  sessionStateStore?: SessionStateStore
  /**
   * MCP injection deps — same shape as `WebChatOptions` so apps/api can
   * spread the same store handles into both routes. Field names match
   * `ChannelMcpStores` in `route-helpers.ts` (structural typing).
   */
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  connectorGrantStore?: ConnectorGrantStore
  connectorInstanceStore?: ConnectorInstanceStore
  gdriveFilesStore?: GDriveFilesStore
  /**
   * Per-assistant connector WRITE grants — `assertActionAllowed` in the
   * Gmail/GCal write callbacks fires only when this store is present (the
   * gate is fail-open when absent). Wired by apps/api for channel parity
   * with web chat; see docs/plans/agent-facing-capability-surface.md §11.2.
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /**
   * Tool-use interception port (remote MCP only), forwarded to
   * `injectMcpTools`. Open default = unset. See
   * `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks
  /**
   * Optional. When supplied, mounts POST /claim-shadow — partner-mediated
   * shadow account merge. See docs/architecture/features/shadow-claim.md.
   */
  shadowClaimStore?: ShadowClaimStore
  /** Maximum query-loop turns. Defaults to 8 — same as web chat. */
  maxTurns?: number
  /** Hard cap on inbound message length, defaults to 16k chars. */
  maxMessageChars?: number
}

const historyQuerySchema = z.object({
  externalUserId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256).optional(),
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : undefined))
    .refine((v) => v === undefined || (Number.isFinite(v) && v > 0 && v <= 500), {
      message: 'limit must be 1..500',
    }),
})

/**
 * Extract user-visible text from a stored content payload. The DB stores
 * `content` as a `ContentBlock[]` JSONB (or rarely a plain string for legacy
 * rows). For the public history view we only surface `text` blocks; tool_use,
 * tool_result, and inline images are filtered out — they're internals.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as ContentBlock[]) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) {
        parts.push(text)
      }
    }
  }
  return parts.join('\n\n').trim()
}

const RETRY_HINT =
  '[Note: the user retried this message. Your previous response did not satisfy them. Take a different angle — do not repeat the same structure, examples, or recommendations.]\n\n'
const EDIT_HINT =
  '[Note: the user edited their previous message. Your earlier response did not satisfy them. Try a different approach or address their revised intent.]\n\n'

const messageSchema = z.object({
  externalUserId: z.string().min(1).max(256),
  externalUserName: z.string().min(1).max(120).optional(),
  externalUserEmail: z.string().email().max(256).optional(),
  /**
   * Opt-in: treat this externalUserId as a stable, real human (Tier 1) so
   * memory tools are exposed and consolidation runs. Default false. Email
   * present implies `identified: true` automatically — passing email is
   * the only way to also enable auto-merge if the same human later signs
   * up via OAuth.
   */
  identified: z.boolean().optional(),
  sessionId: z.string().min(1).max(256).optional(),
  message: z.string().min(1),
  /**
   * Destroy-and-regenerate retry/edit. When set, this UUID names a
   * `session_messages` row in the same session; that row and every
   * subsequent row are deleted before the new turn is appended. The
   * model receives a hint that the user was dissatisfied so it picks
   * a different angle. Mirrors web chat's `truncateFromMessageId`.
   */
  truncateFromMessageId: z.string().uuid().optional(),
}).strict()

type ApiError =
  | 'invalid_input'
  | 'invalid_api_key'
  | 'key_revoked'
  | 'assistant_not_found'
  | 'message_not_found'
  | 'budget_exhausted'
  | 'upstream_failed'
  | 'internal'

function fail(res: import('express').Response, status: number, error: ApiError, detail?: string) {
  res.status(status).json(detail ? { error, detail } : { error })
}

export function publicApiRoutes(options: PublicApiRouteOptions): Router {
  const router = Router()
  const maxTurns = options.maxTurns ?? 8
  const maxMessageChars = options.maxMessageChars ?? 16_000

  router.post<{ assistantId: string }>(
    '/assistants/:assistantId/messages',
    async (req, res) => {
      // ── 1. Auth ──────────────────────────────────────────────
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return fail(res, 401, 'invalid_api_key')
      }
      const parsed = parseAuthToken(header.slice('Bearer '.length))
      if (!parsed) return fail(res, 401, 'invalid_api_key')

      const keyRow = await options.apiKeyStore.getByIdSystem(parsed.keyId)
      if (!keyRow) return fail(res, 401, 'invalid_api_key')

      // URL ↔ key binding. A leaked key for assistant A must NOT be usable
      // against assistant B by URL manipulation.
      if (keyRow.assistantId !== req.params.assistantId) {
        return fail(res, 401, 'invalid_api_key')
      }

      if (keyRow.status !== 'active') return fail(res, 403, 'key_revoked')

      const ok = await verifySecret(parsed.secret, keyRow.keyHash)
      if (!ok) return fail(res, 401, 'invalid_api_key')

      // Fire-and-forget: surface "last used" in the owner UI.
      options.apiKeyStore.touchLastUsedAt(keyRow.id).catch((err) => {
        console.error('[public-api] touchLastUsedAt failed:', err)
      })

      // ── 2. Validate body ─────────────────────────────────────
      const bodyParse = messageSchema.safeParse(req.body)
      if (!bodyParse.success) {
        return fail(res, 400, 'invalid_input', bodyParse.error.message)
      }
      const body = bodyParse.data
      if (body.message.length > maxMessageChars) {
        return fail(res, 400, 'invalid_input', `message exceeds ${maxMessageChars} chars`)
      }

      // ── 3. Assistant + billing party ─────────────────────────
      const assistant = await findAssistantById(req.params.assistantId)
      if (!assistant) return fail(res, 404, 'assistant_not_found')

      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })
      const owner = await findUserById(ownerId)
      if (!owner) return fail(res, 404, 'assistant_not_found')

      // Billing is per-workspace (migration 143) — plan + budget windows
      // belong to the assistant's workspace.
      const workspacePlan = assistant.workspaceId
        ? await getWorkspacePlan(assistant.workspaceId)
        : 'free'

      // ── 4. Resolve consumer-supplied identity ────────────────
      // Auth provider id is namespaced by api key id, NOT by externalUserId
      // alone — revoking a key invalidates its visitor identities cleanly.
      // See docs/architecture/features/public-api.md → "Identity & sessions".
      //
      // Tier 1 (identified) is opted into either explicitly via
      // `identified: true` OR implicitly by passing `externalUserEmail`.
      // Email additionally enables auto-merge if the same human later
      // signs up via OAuth — that's the only path that can set up the
      // bridge, since email is the cross-provider identity key.
      const authProviderId = `api:${keyRow.id}:${body.externalUserId}`
      const wantsIdentified = body.identified === true || !!body.externalUserEmail
      let user
      let isIdentified = false
      if (wantsIdentified) {
        if (body.externalUserEmail) {
          // Tier 1 with email — auto-merge into an existing platform user
          // if one matches by email. Otherwise create the shadow seeded
          // with the email so a future OAuth signup will promote it.
          const existing = await findUserByEmail(body.externalUserEmail)
          if (existing) {
            user = existing
          } else {
            ;({ user } = await findOrCreateUser({
              authProvider: 'channel',
              authProviderId,
              email: body.externalUserEmail,
              name: body.externalUserName,
            }))
          }
        } else {
          // Tier 1 without email — memory tools work, but no auto-merge
          // path because we have no cross-provider identity key. The
          // consumer is asserting "this is a stable real person."
          ;({ user } = await findOrCreateUser({
            authProvider: 'channel',
            authProviderId,
            name: body.externalUserName,
          }))
        }
        isIdentified = true
      } else {
        // Tier 2 — anonymous shadow. Falls back to a stable provider:id
        // string so the row is never nameless.
        const fallbackName = `api:${body.externalUserId}`
        ;({ user } = await findOrCreateUser({
          authProvider: 'channel',
          authProviderId,
          name: body.externalUserName ?? fallbackName,
        }))
      }

      // Ensure the user appears in the assistant's member list — same
      // pattern as resolveChannelUser. Lets the owner see who's been
      // talking to the bot.
      await query(
        `INSERT INTO assistant_members (assistant_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (assistant_id, user_id) DO NOTHING`,
        [assistant.id, user.id],
      )

      // ── 5. Session ───────────────────────────────────────────
      const channelId = body.sessionId ?? body.externalUserId
      const session = await findOrCreateSession({
        assistantId: assistant.id,
        userId: user.id,
        channelType: 'api',
        channelId,
      })

      // ── 5b. Retry/edit — destroy-and-regenerate ─────────────
      // Look up the target message FIRST and verify it lives in this
      // session before truncating. Without this, a leaked message id
      // from session A could be used to delete history from session B
      // by aiming it at the wrong (assistantId, externalUserId, sessionId).
      let retryHint = ''
      if (body.truncateFromMessageId) {
        const target = await query<{ sessionId: string; role: string; content: unknown }>(
          `SELECT session_id as "sessionId", role, content
             FROM session_messages WHERE id = $1`,
          [body.truncateFromMessageId],
        )
        if (target.rows.length === 0 || target.rows[0].sessionId !== session.id) {
          return fail(res, 404, 'message_not_found')
        }

        const { deletedMessages } = await truncateMessagesFrom(body.truncateFromMessageId)
        const oldUser = deletedMessages.find((m) => m.role === 'user')
        const oldAssistant = deletedMessages.find((m) => m.role === 'assistant')
        const oldUserText = oldUser ? extractText(oldUser.content) : ''
        const isEdit = !!oldUser && oldUserText !== body.message

        // Only inject a hint when there was a prior assistant turn to
        // react to — otherwise "do something different" has no referent.
        if (oldAssistant) {
          retryHint = isEdit ? EDIT_HINT : RETRY_HINT
        }

        options.analytics?.logEvent({
          userId: ownerId,
          actorUserId: user.id,
          assistantId: assistant.id,
          sessionId: session.id,
          eventName: isEdit ? 'message_edited' : 'message_retried',
          channelType: 'api',
          metadata: {
            truncatedFromMessageId: sanitizeAnalytics(body.truncateFromMessageId),
            deletedCount: deletedMessages.length,
            oldPromptPreview: oldUser ? sanitizeAnalytics(oldUserText.slice(0, 200)) : undefined,
            oldResponsePreview: oldAssistant
              ? sanitizeAnalytics(extractText(oldAssistant.content).slice(0, 300))
              : undefined,
            newPromptPreview: sanitizeAnalytics(body.message.slice(0, 200)),
          },
        })
      }

      // ── 6. Budget gate ───────────────────────────────────────
      let budgetStatus: 'ok' | 'downgraded' | 'blocked' = 'ok'
      if (options.usageStore && assistant.workspaceId) {
        const gate = await checkUsageBudget(
          assistant.workspaceId,
          workspacePlan,
        )
        budgetStatus = gate.status
        if (gate.status === 'blocked') {
          return fail(
            res,
            429,
            'budget_exhausted',
            "This assistant has hit its usage limit. The assistant owner needs to upgrade their plan.",
          )
        }
      }
      const model = resolveModel(
        assistant.telegramModelAlias,
        workspacePlan,
        budgetStatus,
      )

      // ── 7. Persist user message ──────────────────────────────
      const userContent: ContentBlock[] = [{ type: 'text', text: body.message }]
      const storedUserMsg = await addSessionMessage({
        sessionId: session.id,
        role: 'user',
        content: userContent,
      })

      // ── 8. Tools — mirror web chat ───────────────────────────
      // Same shape as `chat.ts`: capability filter → MCP injection (which
      // pulls in the team owner's connectors, mcp_search/mcp_call, and KB
      // tools) → strip requiresConfirmation tools (no human-in-the-loop on
      // the API channel) → memory tools for Tier 1.
      //
      // Without MCP injection here, an assistant whose system prompt
      // references specific MCP tools (e.g. cgov chat referencing
      // `search_dreps` from cgov-mcp) would silently fail on this channel —
      // the model would see the tool name in the prompt, find no such tool,
      // hallucinate or thought-burn into empty responses. See
      // docs/architecture/features/public-api.md → "Tools available".
      const activeCapabilities = new Set(
        await options.capabilityStore.listActive(assistant.id),
      )
      const baseTools = filterToolsByCapabilities(new Map(options.tools), activeCapabilities)

      const connectorUserId = await getConnectorUserId(user.id, assistant.workspaceId ?? null)
      // Read-side clearance (incident 2026-06-01): read ceiling =
      // min(member, assistant). The API key's principal is typically the
      // workspace owner (resolves to the assistant's clearance), but a
      // lower-clearance principal is correctly bounded. Writes keep the
      // assistant's clearance via `assistantClearance` on the context.
      const { clearance: readClearance, compartments: readCompartments } =
        await resolveReadCeilingsSystem(
          user.id,
          assistant.workspaceId ?? null,
          assistant.clearance,
          assistant.compartments,
        )
      const mcpInjection = await applyMcpInjection({
        scope: 'public-api',
        connectorUserId,
        assistant: { id: assistant.id, workspaceId: assistant.workspaceId ?? null },
        userTimezone: owner.timezone ?? undefined,
        tools: baseTools,
        stores: options,
        engineHooks: options.engineHooks,
      })

      // Strip confirmation-required tools AFTER injection — MCP injectors
      // tag write-tools as `requiresConfirmation` and the API consumer has
      // no way to approve them. Drops them silently (matches the spec's
      // "API path is safe-by-default" posture).
      for (const [, tool] of baseTools) {
        if (tool.requiresConfirmation) {
          baseTools.delete(tool.name)
        }
      }

      // Memory tools — only for Tier 1 (identified) users. Tier 2 shadows
      // get session-only context and shouldn't write memory.
      if (isIdentified) {
        const { saveMemory, getMemory } = createMemoryTools(options.memoryStore)
        baseTools.set('saveMemory', saveMemory)
        baseTools.set('getMemory', getMemory)
      }

      // ── 9. Memory context (Tier 1 only) ──────────────────────
      let memoryContext = ''
      if (isIdentified) {
        const viewerCtx = {
          workspaceId: assistant.workspaceId ?? '',
          userId: user.id,
          assistantId: assistant.id,
          assistantKind: assistant.kind,
          clearance: readClearance,
          compartments: readCompartments,
        }
        const [soul, identityMemories, memoryIndex] = await Promise.all([
          options.memoryStore.getSoul(assistant.id, user.id, 'sidanclaw'),
          options.memoryStore.getIdentity(viewerCtx),
          options.memoryStore.getIndex(viewerCtx),
        ])
        memoryContext = buildMemoryContext({
          soul,
          identityMemories: identityMemories.map((m) => ({ id: m.id, summary: m.summary, detail: m.detail })),
          memoryIndex: memoryIndex.map((m) => ({ ...m, appId: null })),
          workspaceIdentityMemories: [],
          teamMemoryIndex: [],
          assistantName: assistant.name,
        })
      }

      const assistantSystemPrompt = assistant.systemPrompt
        ? `${options.systemPrompt}\n\n${assistant.systemPrompt}`
        : options.systemPrompt
      const promptWithMemory = memoryContext
        ? `${assistantSystemPrompt}\n\n${memoryContext}`
        : assistantSystemPrompt
      // Append the unavailable-capabilities block so the model doesn't
      // burn turns hunting for tools that aren't connected. Same pattern
      // as chat.ts (line 1124).
      const fullSystemPrompt = promptWithMemory + buildUnavailableCapabilitiesPrompt(mcpInjection.unavailable)

      // ── 10. Load history + proactive compaction ──────────────
      // Mirrors web chat (chat.ts:797–816). `runProactiveCompaction`
      // owns stamping + tool-result pairing + summary-prepend + the
      // compaction LLM call when the tier+channel threshold is hit,
      // updating `compact_boundary_sequence` / `compact_summary`
      // in place.
      //
      // `channelClass: 'web'` — the API channel is Q&A-shaped with
      // longer turns, much closer to web chat than rapid messaging
      // (Telegram/Slack run at 0.5×). Without compaction long-lived
      // API sessions grow until Gemini 3 Pro hits its empty-response
      // failure mode on large inputs; see query-loop.ts:372 and the
      // EMPTY_RETRY_PLAN comments.
      const dbMessages = await getSessionMessages(session.id, {
        fromSequence: session.compactBoundarySequence,
      })
      const compactionResult = await runProactiveCompaction({
        sessionMessages: dbMessages,
        timezone: owner.timezone ?? 'UTC',
        session,
        tier: modelToCompactionTier(model),
        channelClass: 'web',
        profile: 'linear',
        provider: options.provider,
        systemPrompt: fullSystemPrompt,
        assistantId: assistant.id,
        userId: user.id,
        ownerId,
        channelType: 'api',
        memoryStore: options.memoryStore,
        episodicStore: options.episodicStore,
        sessionStateStore: options.sessionStateStore,
        analytics: options.analytics,
        usageStore: options.usageStore,
        userMessageId: storedUserMsg.id,
      })
      let messages: Message[] = stripUnsignedToolUses(compactionResult.messages)

      // Inject the retry/edit hint into the last user turn for the
      // model only — the persisted row stays clean. Mirrors
      // chat.ts:808–826.
      if (retryHint && messages.length > 0) {
        const lastIdx = messages.length - 1
        const last = messages[lastIdx]
        if (last.role === 'user') {
          const cloned: Message = {
            role: 'user',
            content:
              typeof last.content === 'string'
                ? retryHint + last.content
                : [{ type: 'text', text: retryHint }, ...last.content],
          }
          messages = [...messages.slice(0, lastIdx), cloned]
        }
      }

      // ── 11. Run query loop ────────────────────────────────────
      // Mirrors web chat (chat.ts:1409–1412): abort on consumer
      // disconnect, with a safety ceiling that exceeds the loop's
      // own EMPTY_RETRY_WALL_MS (90s in query-loop.ts) so the
      // empty-response retry plan is never killed mid-flight.
      const abortController = new AbortController()
      req.on('close', () => abortController.abort())
      const timeout = setTimeout(() => abortController.abort(), 180_000)

      let responseText = ''
      let totalUsage: TokenUsage | null = null
      let responseModel: string | null = null
      let assistantMessageId: string | null = null

      try {
        for await (const event of queryLoop({
          provider: options.provider,
          model,
          systemPrompt: fullSystemPrompt,
          messages,
          tools: baseTools,
          context: {
            userId: user.id,
            assistantId: assistant.id,
            sessionId: session.id,
            appId: 'sidanclaw',
            channelType: 'api',
            channelId,
            // Read ceiling = min(member, assistant); write ceiling stays the
            // assistant's own clearance (incident 2026-06-01).
            clearance: readClearance,
            compartments: readCompartments,
            assistantClearance: assistant.clearance,
            assistantCompartments: assistant.compartments,
            assistantDefaultCompartments: assistant.defaultCompartments,
            workspaceId: assistant.workspaceId ?? undefined,
            assistantKind: assistant.kind,
            userTimezone: owner.timezone ?? undefined,
            abortSignal: abortController.signal,
            sessionStateStore: options.sessionStateStore,
            activeCapabilities,
          },
          channelType: 'api',
          // Reactive compaction on context-overflow errors —
          // matches web chat (chat.ts:1541).
          compactModel: 'gemini-flash',
          maxTurns,
        })) {
          if (event.type === 'text_delta') {
            responseText += event.text
          } else if (event.type === 'turn_complete') {
            totalUsage = event.totalUsage ?? null
            responseModel = event.response.model
            // Skip persisting fully empty assistant turns — same posture
            // as chat.ts (1462). queryLoop's empty-response recovery may
            // still exit empty when EMPTY_RETRY_PLAN or EMPTY_RETRY_WALL_MS
            // is exhausted; persisting `[]` would poison the next turn's
            // history and break tool-result pairing on reload.
            if (event.response.content.length > 0) {
              const stored = await addSessionMessage({
                sessionId: session.id,
                role: 'assistant',
                content: event.response.content,
              })
              assistantMessageId = stored.id
            }
          } else if (event.type === 'error') {
            console.error('[public-api] query loop error:', event.error)
            return fail(res, 502, 'upstream_failed', event.error?.message)
          }
        }
      } catch (err) {
        console.error('[public-api] query loop threw:', err)
        return fail(res, 502, 'upstream_failed', (err as Error).message)
      } finally {
        clearTimeout(timeout)
      }

      // ── 12. Record usage (fire-and-forget) ───────────────────
      // The API-key owner pays (`userId`), but the shadow user actually
      // drove the turn — pass `actorUserId` so admin per-user views can
      // pivot to the shadow. See migration 100 and
      // docs/architecture/platform/analytics.md → "Actor vs billing party".
      if (options.usageStore && totalUsage && responseModel) {
        const cost = calculateCost(responseModel, totalUsage)
        options.usageStore.recordUsage({
          userId: ownerId,
          actorUserId: user.id,
          assistantId: assistant.id,
          sessionId: session.id,
          model: responseModel,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          cacheReadTokens: totalUsage.cacheReadTokens,
          cacheWriteTokens: totalUsage.cacheWriteTokens,
          actualCostUsd: cost,
          source: 'api',
          userMessageId: storedUserMsg.id,
        }).catch((err) => {
          // Mirror chat.ts: log AND surface to analytics so the
          // failure isn't silent. The previous version only console
          // logged, which masked the valid_source CHECK constraint
          // breakage that hid every public-API turn from the
          // dashboard until migration 102.
          console.error('[public-api] usage tracking failed:', err)
          options.analytics?.logEvent({
            userId: ownerId,
            actorUserId: user.id,
            assistantId: assistant.id,
            sessionId: session.id,
            eventName: 'usage_tracking_error',
            channelType: 'api',
            metadata: {
              error_type: sanitizeAnalytics((err as Error)?.name ?? 'unknown'),
            },
          })
        })
      }

      options.analytics?.logEvent({
        userId: ownerId,
        actorUserId: user.id,
        assistantId: assistant.id,
        sessionId: session.id,
        eventName: 'api_request',
        channelType: 'api',
        metadata: {
          api_key_id: sanitizeAnalytics(keyRow.id),
          identified: isIdentified,
          tokens_in: totalUsage?.inputTokens ?? 0,
          tokens_out: totalUsage?.outputTokens ?? 0,
        },
      })

      // Strip any model scaffolding / meta-commentary — programmatic consumers
      // have no client render layer to do it (see sanitizeDeliveryText).
      const trimmed = sanitizeDeliveryText(responseText)
      res.json({
        sessionId: channelId,
        messageId: assistantMessageId ?? randomUUID(),
        reply: trimmed.length > 0 ? trimmed : "I couldn't generate a reply — please rephrase or try again.",
        model: responseModel ?? model,
      })
    },
  )

  /**
   * GET /assistants/:assistantId/messages
   *
   * Read-only session history for a given (assistantId, externalUserId,
   * sessionId) tuple. Returns text-only messages so the consumer's UI
   * can self-heal after refreshes/tab closes that interrupted a POST.
   *
   * No side effects: does NOT auto-create the user or session.
   */
  router.get<{ assistantId: string }>(
    '/assistants/:assistantId/messages',
    async (req, res) => {
      // ── Auth — mirror POST exactly ───────────────────────────
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return fail(res, 401, 'invalid_api_key')
      }
      const parsed = parseAuthToken(header.slice('Bearer '.length))
      if (!parsed) return fail(res, 401, 'invalid_api_key')

      const keyRow = await options.apiKeyStore.getByIdSystem(parsed.keyId)
      if (!keyRow) return fail(res, 401, 'invalid_api_key')
      if (keyRow.assistantId !== req.params.assistantId) {
        return fail(res, 401, 'invalid_api_key')
      }
      if (keyRow.status !== 'active') return fail(res, 403, 'key_revoked')

      const ok = await verifySecret(parsed.secret, keyRow.keyHash)
      if (!ok) return fail(res, 401, 'invalid_api_key')

      // ── Validate query ──────────────────────────────────────
      const queryParse = historyQuerySchema.safeParse(req.query)
      if (!queryParse.success) {
        return fail(res, 400, 'invalid_input', queryParse.error.message)
      }
      const q = queryParse.data
      const limit = q.limit ?? 100

      // ── Resolve user (read-only) ────────────────────────────
      const authProviderId = `api:${keyRow.id}:${q.externalUserId}`
      const user = await findUserByAuthProvider('channel', authProviderId)
      if (!user) {
        // No user yet → no history. Return empty rather than 404 so the
        // client can hydrate cleanly on first load.
        return res.json({ sessionId: q.sessionId ?? q.externalUserId, messages: [] })
      }

      // ── Locate session ──────────────────────────────────────
      const channelId = q.sessionId ?? q.externalUserId
      const session = await findSessionByChannel({
        assistantId: req.params.assistantId,
        userId: user.id,
        channelType: 'api',
        channelId,
      })
      if (!session) {
        return res.json({ sessionId: channelId, messages: [] })
      }

      // ── Fetch + project messages ────────────────────────────
      const rows = await getSessionMessages(session.id, { limit })
      const messages = rows
        .map((row) => ({
          id: row.id,
          role: row.role,
          content: extractText(row.content),
          sequenceNum: row.sequenceNum,
          createdAt: row.createdAt,
        }))
        .filter(
          (m) =>
            (m.role === 'user' || m.role === 'assistant') && m.content.length > 0,
        )

      return res.json({ sessionId: channelId, messages })
    },
  )

  // ── POST /claim-shadow ──────────────────────────────────────────
  // Partner-mediated shadow account claim. Exchanges a one-time
  // claim_token (minted by the consent page in apps/web) for an
  // atomic merge of the shadow into the consenting sidanclaw user.
  //
  // Both halves of consent are checked here:
  //   1. The Bearer API key proves the partner owns the shadow's
  //      identity namespace (token's partner_key_id must match).
  //   2. The claim_token proves the sidanclaw user authorized the
  //      merge (single-use, 5min TTL, bound to the triple at mint).
  //
  // See docs/architecture/features/shadow-claim.md.
  if (options.shadowClaimStore) {
    const shadowClaimStore = options.shadowClaimStore

    const claimSchema = z.object({
      claimToken: z.string().min(1).max(512),
      externalUserId: z.string().min(1).max(256),
    }).strict()

    router.post('/claim-shadow', async (req, res) => {
      // ── Auth (same shape as the messages route) ─────────────
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return fail(res, 401, 'invalid_api_key')
      }
      const parsed = parseAuthToken(header.slice('Bearer '.length))
      if (!parsed) return fail(res, 401, 'invalid_api_key')

      const keyRow = await options.apiKeyStore.getByIdSystem(parsed.keyId)
      if (!keyRow) return fail(res, 401, 'invalid_api_key')
      if (keyRow.status !== 'active') return fail(res, 403, 'key_revoked')
      const ok = await verifySecret(parsed.secret, keyRow.keyHash)
      if (!ok) return fail(res, 401, 'invalid_api_key')

      // ── Body ─────────────────────────────────────────────────
      const bodyParse = claimSchema.safeParse(req.body)
      if (!bodyParse.success) {
        return fail(res, 400, 'invalid_input', bodyParse.error.message)
      }
      const { claimToken, externalUserId } = bodyParse.data

      // ── Consume token atomically ────────────────────────────
      const consumed = await shadowClaimStore.consume(claimToken)
      if (!consumed.ok) {
        const status = consumed.reason === 'not_found' ? 404
          : consumed.reason === 'already_used' ? 409
          : 410
        const slug = consumed.reason === 'not_found' ? 'claim_token_not_found'
          : consumed.reason === 'already_used' ? 'claim_token_consumed'
          : 'claim_token_expired'
        res.status(status).json({ error: slug })
        return
      }
      const tokenRow = consumed.row

      // ── Cross-check partner identity ────────────────────────
      // The token is bound to a partner_key at mint time; the request's
      // API key must match. Without this, a leaked claim_token would
      // let any other partner-key holder steal the merge.
      if (tokenRow.partnerKeyId !== keyRow.id) {
        res.status(403).json({ error: 'partner_key_mismatch' })
        return
      }
      // The external_user_id in the body must match what the user
      // consented to — defence-in-depth against partner-side wiring bugs.
      if (tokenRow.externalUserId !== externalUserId) {
        return fail(res, 400, 'invalid_input', 'externalUserId does not match consented value')
      }

      // ── Merge ────────────────────────────────────────────────
      try {
        const result = await mergeShadowUser(
          tokenRow.realUserId,
          externalUserId,
          'api',
          {
            partnerKeyId: keyRow.id,
            reason: 'partner-claim',
            evidence: { token: tokenRow.token, partnerKeyId: keyRow.id },
          },
        )
        if (!result.merged) {
          // The shadow may have been deleted between consent and consume —
          // surface that explicitly rather than silently 200ing.
          res.status(404).json({ error: 'shadow_not_found' })
          return
        }
        res.json({
          merged: true,
          realUserId: tokenRow.realUserId,
          shadowUserId: tokenRow.shadowUserId,
        })
      } catch (err) {
        console.error('[public-api/claim-shadow] merge failed:', err)
        return fail(res, 500, 'internal', (err as Error).message)
      }
    })
  }

  return router
}
