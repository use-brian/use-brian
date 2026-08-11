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
 * Delivery shape:
 *   - Synchronous JSON by default; `Accept: text/event-stream` streams the
 *     same turn's live query-loop deltas without changing request semantics.
 *   - Base + KB tools, PLUS the same MCP injection web chat gets
 *     (`applyMcpInjection`, scope `public-api`): granted connectors and
 *     `mcp_search`/`mcp_call`. Confirmation-required tools are stripped
 *     after injection — this surface has no Approve/Deny loop — and KB
 *     writes never enter it (`allowKnowledgeWrites: false`).
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
import { findAssistantById, findUserByEmail, findUserById } from '../db/users.js'
import { getWorkspaceMembershipSystem } from '../db/workspace-store.js'

export type PublicApiRouteOptions = {
  provider: LLMProvider
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
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
  /** Internal-audience keys only — same attribution rules as the POST. */
  actorEmail: z.string().email().max(256).optional(),
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
 * Turn-scoped auth power attested by the consumer's backend.
 *
 * Brian never authenticates end users. The `sk_live_` key holder — server
 * side only — authenticates its own user and attests the identity on every
 * request, the same shape as OAuth token exchange. A claim is therefore only
 * as trustworthy as the key, which is the intended bar.
 *
 * Claims are NEVER persisted as authority. `externalUserId` is the durable
 * index key; claims expire with the turn, so a customer who signed in once in
 * March and browses logged-out in June has no auth power back-filled from the
 * stored pairing. Absent claims = gates closed, even for a known user.
 * See docs/architecture/features/public-api.md → "End-user identity".
 */
const claimsSchema = z.object({
  /** Alias of the top-level `externalUserEmail`; both present and differing → 400. */
  email: z.string().email().max(256).optional(),
  /** Consumer's tenant id. Forwarded on the transport, semantically inert here. */
  orgId: z.string().min(1).max(256).optional(),
  /**
   * Advisory only — prompt-visible for tone and routing, never forwarded as a
   * header. Identity is forwarded, authorization is derived: a bridge must
   * resolve authority from its own records keyed on the actor id.
   */
  roles: z.array(z.string().min(1).max(64)).max(16).optional(),
}).strict()

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
  claims: claimsSchema.optional(),
  /**
   * Consumer-passed per-turn account context (plan tier, open orders, ticket
   * state). Enters the prompt through the trusted system channel, labelled as
   * consumer-attested. Turn-scoped: never persisted, never consolidated.
   */
  endUserContext: z.string().max(4000).optional(),
  /**
   * Internal-audience keys only (docs/plans/api-chat-modes.md §3 D4): the
   * workspace member this turn acts as. Omitted → the key's creator. Must
   * resolve to a member of the assistant's workspace (403 actor_not_member).
   * On an external key this field is a 400 — attribution is an internal-lane
   * concept, not a per-request escalation.
   */
  actorEmail: z.string().email().max(256).optional(),
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
}).strict().superRefine((body, ctx) => {
  // `externalUserEmail` is the back-compat alias of `claims.email` — one
  // email semantic, not two. Two email fields with different tier behavior
  // would be a footgun, so a consumer migrating to `claims` may send both
  // only if they agree. Disagreement means the consumer's two code paths
  // resolved different people for one turn; that is a bug on their side and
  // guessing which one is right would silently mis-attribute the memory,
  // the CRM link, and the connector headers. Reject at the wire.
  const aliased = body.claims?.email
  if (aliased && body.externalUserEmail && aliased !== body.externalUserEmail) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claims', 'email'],
      message:
        'claims.email and externalUserEmail must match — externalUserEmail is the ' +
        'back-compat alias of claims.email. Send one, or send both with the same value.',
    })
  }
})

/** Exact content negotiation for the public assistant stream. Wildcards keep
 * the backwards-compatible JSON response; callers must opt in explicitly. */
export function acceptsPublicAssistantSse(accept: string | string[] | undefined): boolean {
  if (typeof accept !== 'string') return false
  return accept.split(',').some((entry) =>
    entry.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream',
  )
}

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
      // Lane derivation (docs/plans/api-chat-modes.md §3):
      //
      // Internal key (D4) → 'internal-member': the turn acts as an attributed
      // workspace member (default: the key's creator). The external-lane tier
      // machinery is a 400 here — claims/identified/externalUserEmail attest
      // *customers*, and accepting them on an internal key would blur the one
      // distinction the audience column exists to keep sharp.
      //
      // External key, anonymous turn, anonymous_context='full' (D2) →
      // 'assistant-full': the owner opted into the chat-link trust posture at
      // creation. Indexed (Tier-1) turns stay on the thin external-client
      // scope regardless (D3), so the lane check mirrors public-turn's own
      // `wantsIdentified` derivation. `actorEmail` on an external key is a
      // 400 — attribution is not a per-request escalation.
      if (keyRow.audience === 'internal') {
        if (body.identified !== undefined || body.claims !== undefined || body.externalUserEmail !== undefined) {
          return fail(
            res,
            400,
            'invalid_input',
            'identified/claims/externalUserEmail are external-lane fields and not valid with an internal-audience key',
          )
        }
        await executePublicTurn(
          options,
          {
            assistantId: req.params.assistantId,
            identityNamespace: `api:${keyRow.id}`,
            body,
            contextScope: 'internal-member',
            internalActor: { email: body.actorEmail ?? null, defaultUserId: keyRow.createdBy },
            delivery: acceptsPublicAssistantSse(req.headers.accept) ? 'sse' : 'json',
            analyticsMeta: { api_key_id: keyRow.id, context_scope: 'internal-member' },
          },
          req,
          res,
        )
        return
      }
      if (body.actorEmail !== undefined) {
        return fail(
          res,
          400,
          'invalid_input',
          'actorEmail requires an internal-audience key',
        )
      }
      const wantsIdentified =
        body.identified === true || !!(body.claims?.email ?? body.externalUserEmail)
      const fullAnonymousLane =
        keyRow.anonymousContext === 'full' && !wantsIdentified
      await executePublicTurn(
        options,
        {
          assistantId: req.params.assistantId,
          identityNamespace: `api:${keyRow.id}`,
          body,
          contextScope: fullAnonymousLane ? 'assistant-full' : undefined,
          delivery: acceptsPublicAssistantSse(req.headers.accept) ? 'sse' : 'json',
          analyticsMeta: { api_key_id: keyRow.id, context_scope: fullAnonymousLane ? 'assistant-full' : 'external-client' },
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

      // Internal keys read a member's sessions, not a shadow's — resolve the
      // actor with the same rules as the POST (attribution email, defaulting
      // to the key's creator; membership validated, fails closed).
      let resolvedUserId: string | undefined
      if (keyRow.audience === 'internal') {
        const actorUser = q.actorEmail
          ? await findUserByEmail(q.actorEmail)
          : keyRow.createdBy
            ? await findUserById(keyRow.createdBy)
            : null
        const assistant = actorUser ? await findAssistantById(req.params.assistantId) : null
        const membership =
          actorUser && assistant?.workspaceId
            ? await getWorkspaceMembershipSystem(actorUser.id, assistant.workspaceId)
            : null
        if (!actorUser || !membership) {
          return fail(res, 403, 'actor_not_member')
        }
        resolvedUserId = actorUser.id
      } else if (q.actorEmail !== undefined) {
        return fail(res, 400, 'invalid_input', 'actorEmail requires an internal-audience key')
      }

      await handlePublicHistory(
        {
          assistantId: req.params.assistantId,
          identityNamespace: `api:${keyRow.id}`,
          externalUserId: q.externalUserId,
          sessionId: q.sessionId,
          limit: q.limit ?? 100,
          resolvedUserId,
        },
        res,
      )
    },
  )

  return router
}
