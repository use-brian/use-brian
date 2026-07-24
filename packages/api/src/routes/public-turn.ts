/**
 * Shared public turn pipeline — the body of the public API's message
 * handler, extracted so two front doors can drive it:
 *
 *   - `public-api.ts`  — key-authed (`sk_live_…`), server-to-server.
 *   - `public-chat.ts` — chat-link-token-authed, the anonymous browser
 *     surface at `/c/<token>` (docs/architecture/features/public-chat-link.md).
 *
 * Everything channel-shaped is identical between the two: `channelType
 * 'api'` sessions, owner-pays billing (`source: 'api'`, `actorUserId` =
 * shadow), Tier-1/Tier-2 identity, budget gate, MCP injection with the
 * `public-api` scope + `allowKnowledgeWrites: false`, confirmation-tool
 * strip, proactive compaction, `sanitizeDeliveryText` on exit. The
 * callers differ only in auth, identity namespace, and analytics
 * metadata — see `PublicTurnInput`.
 *
 * Spec: docs/architecture/features/public-api.md (pipeline semantics),
 * docs/architecture/features/public-chat-link.md (the second caller).
 * [COMP:api/public-turn]
 */

import { randomUUID } from 'node:crypto'
import {
  queryLoop,
  buildMemoryContext,
  createMemoryTools,
  calculateCost,
  filterToolsByCapabilities,
  sanitize as sanitizeAnalytics,
  stripUnsignedToolUses, modelRequiresToolSignatures,
  modelToCompactionTier,
} from '@use-brian/core'
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
} from '@use-brian/core'
import type { ContentBlock, EngineHooks } from '@use-brian/core'
import { sanitizeDeliveryText } from '@use-brian/shared'
import { runProactiveCompaction } from './proactive-compaction.js'
import { notifyBrainWriteIfMatch } from '../brain-stream/notify.js'
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
import { billingPartyForAssistant } from '../billing-party.js'
import { resolveModel, ensureServableModel } from '../model-resolution.js'
import { checkUsageBudget, type CreditBudgetGate } from './route-helpers.js'
import { query } from '../db/client.js'

/** Everything the pipeline needs — a structural subset of
 *  `PublicApiRouteOptions`, so `public-api.ts` passes its options
 *  object straight through. */
export type PublicTurnDeps = {
  provider: LLMProvider
  configuredProviders?: ReadonlySet<string>
  tools: Map<string, Tool>
  systemPrompt: string
  memoryStore: MemoryStore
  usageStore?: UsageStore
  knowledgeStore?: KnowledgeStoreInterface
  capabilityStore: CapabilityStore
  analytics?: AnalyticsLogger
  episodicStore?: EpisodicStore
  sessionStateStore?: SessionStateStore
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  connectorGrantStore?: ConnectorGrantStore
  connectorInstanceStore?: ConnectorInstanceStore
  gdriveFilesStore?: GDriveFilesStore
  filesApi?: import('@use-brian/core').FilesApi
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  engineHooks?: EngineHooks
  maxTurns?: number
  checkCreditBudget?: CreditBudgetGate
}

/** The validated turn request — the caller owns schema validation. */
export type PublicTurnBody = {
  externalUserId: string
  externalUserName?: string
  externalUserEmail?: string
  identified?: boolean
  sessionId?: string
  message: string
  truncateFromMessageId?: string
}

export type PublicTurnInput = {
  assistantId: string
  /**
   * Prefix for the shadow user's auth-provider id: the full id is
   * `${identityNamespace}:${externalUserId}`. `api:<keyId>` for the
   * keyed route, `chatlink:<linkId>` for the chat-link route — so
   * revoking the credential orphans its visitor identities cleanly.
   */
  identityNamespace: string
  body: PublicTurnBody
  /** Extra analytics metadata (api_key_id / chat_link_id …). */
  analyticsMeta?: Record<string, unknown>
}

export type PublicApiError =
  | 'invalid_input'
  | 'invalid_api_key'
  | 'key_revoked'
  | 'link_not_found'
  | 'link_budget_exhausted'
  | 'assistant_not_found'
  | 'message_not_found'
  | 'budget_exhausted'
  | 'upstream_failed'
  | 'internal'

export function fail(
  res: import('express').Response,
  status: number,
  error: PublicApiError,
  detail?: string,
) {
  res.status(status).json(detail ? { error, detail } : { error })
}

/**
 * Extract user-visible text from a stored content payload. The DB stores
 * `content` as a `ContentBlock[]` JSONB (or rarely a plain string for legacy
 * rows). For the public history view we only surface `text` blocks; tool_use,
 * tool_result, and inline images are filtered out — they're internals.
 */
export function extractText(content: unknown): string {
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

/**
 * Run one public turn end-to-end and write the JSON response.
 *
 * The caller has already authenticated (API key / chat-link token) and
 * validated the body. Numbered sections mirror the original handler in
 * `public-api.ts` so the two files stay diffable against history.
 */
export async function executePublicTurn(
  deps: PublicTurnDeps,
  input: PublicTurnInput,
  req: import('express').Request,
  res: import('express').Response,
): Promise<void> {
  const maxTurns = deps.maxTurns ?? 8
  const body = input.body

  // ── 3. Assistant + billing party ─────────────────────────
  const assistant = await findAssistantById(input.assistantId)
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
  // Auth provider id is namespaced by the credential (API key id or
  // chat-link id), NOT by externalUserId alone — revoking the
  // credential invalidates its visitor identities cleanly.
  // See docs/architecture/features/public-api.md → "Identity & sessions".
  //
  // Tier 1 (identified) is opted into either explicitly via
  // `identified: true` OR implicitly by passing `externalUserEmail`.
  // The chat-link route never passes either, so its visitors are
  // always Tier 2 by construction.
  const authProviderId = `${input.identityNamespace}:${body.externalUserId}`
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

    deps.analytics?.logEvent({
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
  if (deps.usageStore && assistant.workspaceId) {
    const gate = await checkUsageBudget(
      assistant.workspaceId,
      workspacePlan,
      deps.checkCreditBudget,
    )
    budgetStatus = gate.status
    if (gate.status === 'blocked') {
      return fail(
        res,
        429,
        'budget_exhausted',
        "This workspace has no active Use Brian plan. The workspace owner can pick a plan at usebrian.ai/plans, or self-host the open-source version.",
      )
    }
  }
  const model = deps.configuredProviders
    ? ensureServableModel(
        resolveModel(assistant.telegramModelAlias, workspacePlan, budgetStatus),
        deps.configuredProviders,
      )
    : resolveModel(assistant.telegramModelAlias, workspacePlan, budgetStatus)

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
    await deps.capabilityStore.listActive(assistant.id),
  )
  const baseTools = filterToolsByCapabilities(new Map(deps.tools), activeCapabilities)

  const connectorUserId = await getConnectorUserId(user.id, assistant.workspaceId ?? null)
  // Read-side clearance (incident 2026-06-01): read ceiling =
  // min(member, assistant). The API key's principal is typically the
  // workspace owner (resolves to the assistant's clearance), but a
  // lower-clearance principal is correctly bounded — an anonymous
  // chat-link visitor floors to 'public'. Writes keep the assistant's
  // clearance via `assistantClearance` on the context.
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
    stores: deps,
    engineHooks: deps.engineHooks,
    // KB write tools are chat-only (D2): the API consumer has no
    // Approve/Deny loop, so this surface never exposes them. The
    // confirmation-strip below would drop them anyway — this keeps
    // them out of the injector's `mcp_search` index too.
    allowKnowledgeWrites: false,
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
    const { saveMemory, getMemory } = createMemoryTools(deps.memoryStore)
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
      deps.memoryStore.getSoul(assistant.id, user.id, 'Use Brian'),
      deps.memoryStore.getIdentity(viewerCtx),
      deps.memoryStore.getIndex(viewerCtx),
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
    ? `${deps.systemPrompt}\n\n${assistant.systemPrompt}`
    : deps.systemPrompt
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
    provider: deps.provider,
    systemPrompt: fullSystemPrompt,
    assistantId: assistant.id,
    userId: user.id,
    ownerId,
    channelType: 'api',
    memoryStore: deps.memoryStore,
    episodicStore: deps.episodicStore,
    sessionStateStore: deps.sessionStateStore,
    analytics: deps.analytics,
    usageStore: deps.usageStore,
    userMessageId: storedUserMsg.id,
  })
  // Gate on the serving provider (the `model` resolved above) — the strip
  // is Gemini-only and would erase a Qwen turn's tool calls. See tool-pairing.ts.
  let messages: Message[] = stripUnsignedToolUses(
    compactionResult.messages,
    modelRequiresToolSignatures(model),
  )

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
      provider: deps.provider,
      model,
      systemPrompt: fullSystemPrompt,
      messages,
      tools: baseTools,
      context: {
        userId: user.id,
        assistantId: assistant.id,
        sessionId: session.id,
        appId: 'Use Brian',
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
        sessionStateStore: deps.sessionStateStore,
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
      } else if (event.type === 'tool_result') {
        // Realtime parity with the web chat lane (realtime-sync): a
        // brain write from a public-API turn repaints open brain pages.
        for (const block of event.results) {
          if (block.type !== 'tool_result') continue
          notifyBrainWriteIfMatch(
            assistant.workspaceId,
            block.name,
            block.isError ?? false,
          )
        }
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
        console.error('[public-turn] query loop error:', event.error)
        return fail(res, 502, 'upstream_failed', event.error?.message)
      }
    }
  } catch (err) {
    console.error('[public-turn] query loop threw:', err)
    return fail(res, 502, 'upstream_failed', (err as Error).message)
  } finally {
    clearTimeout(timeout)
  }

  // ── 12. Record usage (fire-and-forget) ───────────────────
  // The credential's owner pays (`userId`), but the shadow user actually
  // drove the turn — pass `actorUserId` so admin per-user views can
  // pivot to the shadow. See migration 100 and
  // docs/architecture/platform/analytics.md → "Actor vs billing party".
  if (deps.usageStore && totalUsage && responseModel) {
    const cost = calculateCost(responseModel, totalUsage)
    deps.usageStore.recordUsage({
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
      console.error('[public-turn] usage tracking failed:', err)
      deps.analytics?.logEvent({
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

  deps.analytics?.logEvent({
    userId: ownerId,
    actorUserId: user.id,
    assistantId: assistant.id,
    sessionId: session.id,
    eventName: 'api_request',
    channelType: 'api',
    metadata: {
      ...input.analyticsMeta,
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
}

export type PublicHistoryInput = {
  assistantId: string
  identityNamespace: string
  externalUserId: string
  sessionId?: string
  limit: number
}

/**
 * Read-only session history for a (assistant, visitor, session) tuple.
 * Text-only projection; no side effects (does NOT auto-create the user
 * or session). Shared by the keyed GET and the chat-link GET.
 */
export async function handlePublicHistory(
  input: PublicHistoryInput,
  res: import('express').Response,
): Promise<void> {
  const authProviderId = `${input.identityNamespace}:${input.externalUserId}`
  const user = await findUserByAuthProvider('channel', authProviderId)
  if (!user) {
    // No user yet → no history. Return empty rather than 404 so the
    // client can hydrate cleanly on first load.
    res.json({ sessionId: input.sessionId ?? input.externalUserId, messages: [] })
    return
  }

  const channelId = input.sessionId ?? input.externalUserId
  const session = await findSessionByChannel({
    assistantId: input.assistantId,
    userId: user.id,
    channelType: 'api',
    channelId,
  })
  if (!session) {
    res.json({ sessionId: channelId, messages: [] })
    return
  }

  const rows = await getSessionMessages(session.id, { limit: input.limit })
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

  res.json({ sessionId: channelId, messages })
}
