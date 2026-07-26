/**
 * Public API — third-party integration surface.
 *
 * See docs/architecture/features/public-api.md for the full design.
 * Component tag: [COMP:api/public-api-route].
 *
 * Mounted at `/api/v1`. Authenticated via API keys minted from the
 * assistant's settings page. Each consumer (the third-party service
 * holding the API key) passes their own opaque `externalUserId`;
 * Use Brian maps that to a Tier 1 (with email) or Tier 2 (without
 * email) shadow user.
 *
 * v1 shape:
 *   - Synchronous JSON, no SSE.
 *   - Base + KB tools only — no MCP, no inter-assistant.
 *   - KB clearance inherits the assistant's `clearance` field — owners
 *     pick the right assistant for the right consumer tier.
 *   - Owner pays via existing usage budget (no per-key cap yet).
 *
 * The turn pipeline itself lives in `public-turn.ts`
 * (`[COMP:api/public-turn]`) — shared with the chat-link surface
 * (`public-chat.ts`, docs/architecture/features/public-chat-link.md).
 * This file owns only the key auth + request validation.
 */

import { Router } from 'express'
import { z } from 'zod'
import type {
  LLMProvider,
  Tool,
  MemoryStore,
  UsageStore,
  CapabilityStore,
  KnowledgeStoreInterface,
  AnalyticsLogger,
  EpisodicStore,
  SessionStateStore,
  McpSettingsStore,
  GDriveFilesStore,
} from '@use-brian/core'
import type { EngineHooks } from '@use-brian/core'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { CreditBudgetGate } from './route-helpers.js'
import {
  parseAuthToken,
  verifySecret,
  type ApiKeyStore,
} from '../db/api-key-store.js'
import {
  executePublicTurn,
  handlePublicHistory,
  fail,
} from './public-turn.js'

export type PublicApiRouteOptions = {
  provider: LLMProvider
  /** Provider names configured at boot — substitutes a servable model when the
   *  resolved default (Gemini) has no key. See `ensureServableModel`. */
  configuredProviders?: ReadonlySet<string>
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
  /** Workspace-files byte layer — `gmailSendMessage` attachments (forwarded
   *  via `applyMcpInjection`; the confirmation-strip below still drops the
   *  send tool on this surface, so this is parity plumbing). */
  filesApi?: import('@use-brian/core').FilesApi
  /**
   * Per-assistant connector WRITE grants — `assertActionAllowed` in the
   * Gmail/GCal write callbacks fires only when this store is present (the
   * gate is fail-open when absent). Wired by apps/api for channel parity
   * with web chat; see docs/architecture/integrations/agent-capability-surface.md §11.2.
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  /**
   * Tool-use interception port (remote MCP only), forwarded to
   * `injectMcpTools`. Open default = unset. See
   * `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks
  /** Maximum query-loop turns. Defaults to 8 — same as web chat. */
  maxTurns?: number
  /** Hard cap on inbound message length, defaults to 16k chars. */
  maxMessageChars?: number
  /**
   * The real DB-backed credit gate (closed `billing/credit-gate.ts`),
   * injected by the platform via `boot()` ports — same seam as `chat.ts`.
   * Open default = unset → `checkUsageBudget` allow-alls (self-host is
   * never gated). `blocked` means the workspace has no active plan; see
   * cost-and-pricing.md → "No free plan: the hosted paid gate".
   */
  checkCreditBudget?: CreditBudgetGate
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

export function publicApiRoutes(options: PublicApiRouteOptions): Router {
  const router = Router()
  const maxMessageChars = options.maxMessageChars ?? 16_000

  /**
   * Shared key auth for every keyed endpoint. Returns the key row or
   * writes the failure response and returns null.
   */
  async function authenticateKey(
    req: import('express').Request,
    res: import('express').Response,
    boundAssistantId?: string,
  ) {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      fail(res, 401, 'invalid_api_key')
      return null
    }
    const parsed = parseAuthToken(header.slice('Bearer '.length))
    if (!parsed) {
      fail(res, 401, 'invalid_api_key')
      return null
    }

    const keyRow = await options.apiKeyStore.getByIdSystem(parsed.keyId)
    if (!keyRow) {
      fail(res, 401, 'invalid_api_key')
      return null
    }

    // URL ↔ key binding. A leaked key for assistant A must NOT be usable
    // against assistant B by URL manipulation.
    if (boundAssistantId !== undefined && keyRow.assistantId !== boundAssistantId) {
      fail(res, 401, 'invalid_api_key')
      return null
    }

    if (keyRow.status !== 'active') {
      fail(res, 403, 'key_revoked')
      return null
    }

    const ok = await verifySecret(parsed.secret, keyRow.keyHash)
    if (!ok) {
      fail(res, 401, 'invalid_api_key')
      return null
    }
    return keyRow
  }

  router.post<{ assistantId: string }>(
    '/assistants/:assistantId/messages',
    async (req, res) => {
      // ── 1. Auth ──────────────────────────────────────────────
      const keyRow = await authenticateKey(req, res, req.params.assistantId)
      if (!keyRow) return

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

      // ── 3+. Shared turn pipeline (public-turn.ts) ────────────
      await executePublicTurn(
        options,
        {
          assistantId: req.params.assistantId,
          identityNamespace: `api:${keyRow.id}`,
          body,
          analyticsMeta: { api_key_id: keyRow.id },
        },
        req,
        res,
      )
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
      const keyRow = await authenticateKey(req, res, req.params.assistantId)
      if (!keyRow) return

      // ── Validate query ──────────────────────────────────────
      const queryParse = historyQuerySchema.safeParse(req.query)
      if (!queryParse.success) {
        return fail(res, 400, 'invalid_input', queryParse.error.message)
      }
      const q = queryParse.data

      await handlePublicHistory(
        {
          assistantId: req.params.assistantId,
          identityNamespace: `api:${keyRow.id}`,
          externalUserId: q.externalUserId,
          sessionId: q.sessionId,
          limit: q.limit ?? 100,
        },
        res,
      )
    },
  )

  return router
}
