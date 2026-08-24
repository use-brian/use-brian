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
  buildAssistantNameSection,
  buildMemoryContext,
  createMemoryTools,
  calculateCost,
  filterToolsByCapabilities,
  sanitize as sanitizeAnalytics,
  stripUnsignedToolUses, modelRequiresToolSignatures,
  modelToCompactionTier,
  unionCompartments,
  buildWorkspaceFilesContext,
  buildSessionStateBlock,
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
import { sanitizeDeliveryText, resolveCharter, renderCharterBlock } from '@use-brian/shared'
import { listActivePlaybookRules } from '../db/playbook-store.js'
import { runProactiveCompaction } from './proactive-compaction.js'
import { notifyBrainWriteIfMatch } from '../brain-stream/notify.js'
import { applyMcpInjection, buildUnavailableCapabilitiesPrompt, injectSkills } from './route-helpers.js'
import {
  attachUserVisibleContext,
  buildSplitSystemPrompt,
  formatPrivateRuntimeContext,
  formatUserVisibleContext,
} from './_prompt-builder.js'
import { resolveBrandContext } from '../brand/prompt-context.js'
import {
  getConnectorUserId,
  getWorkspaceMembershipSystem,
  getWorkspacePlan,
  resolveReadCeilingsSystem,
} from '../db/workspace-store.js'
import { isExternalPrincipal } from '../db/external-principal.js'
import { accrueClientPrincipal } from './client-accrual.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import {
  findAssistantById,
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
import { resolveChatModelSelection } from '../model-resolution.js'
import { checkUsageBudget, type CreditBudgetGate } from './route-helpers.js'
import { query } from '../db/client.js'
import type { ProviderAvailability } from '@use-brian/shared/model-registry'
import {
  applyPublicResearchToolCeiling,
  resolveClientSelfMemory,
  resolveExternalClientIdentity,
} from './client-principal-runtime.js'

// Backward-compatible exports for callers/tests that imported these pure
// seams from public-turn before the reusable principal runtime was extracted.
export { applyPublicResearchToolCeiling, resolveClientSelfMemory } from './client-principal-runtime.js'

/** Everything the pipeline needs — a structural subset of
 *  `PublicApiRouteOptions`, so `public-api.ts` passes its options
 *  object straight through. */
export type PublicTurnDeps = {
  provider: LLMProvider
  /** OSS workspace custom endpoint default for the main response only. */
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  configuredProviders?: ProviderAvailability
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
  /**
   * Ambient `# Workspace Files` index. Only read on an `assistant-full`
   * turn (see `PublicTurnContextScope`); the keyed API never builds the
   * block, so leaving this unset keeps that path byte-identical.
   */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /**
   * Skills catalogue. Same gating as `workspaceFilesStore` — an
   * `external-client` turn never injects skills.
   */
  skillStore?: import('../db/skill-store.js').SkillStore
}

/**
 * How much of the assistant's own context a public turn reconstructs.
 *
 * `'external-client'` (default) is the keyed `sk_live_*` API: the caller is a
 * consumer's backend serving its OWN end-customers, so the turn is deliberately
 * thin. Reads floor to the visitor's membership (`public` for a stranger) and
 * the ambient workspace blocks are omitted — the assistant is a service here,
 * not a colleague, and the `client:*` compartment wall plus the `public` floor
 * are the isolation contract (`docs/plans/client-principal.md`).
 *
 * `'assistant-full'` is the public chat link (`/c/<token>`): the owner is
 * publishing THEIR assistant, so it reconstructs the context that assistant
 * would have in web chat — memory, brand, files, skills, wall-clock time — and
 * reads follow the assistant's own clearance instead of flooring to `public`.
 *
 * `'internal-member'` is the internal-audience key (docs/plans/api-chat-modes.md
 * §3 D4): the turn runs as a real, attributed workspace member - no shadow
 * user, no `client:*` stamp, no client accrual - with member-grade reads
 * (min of member and assistant ceilings) and the member's own memory.
 * Web chat over an API key.
 *
 * The scopes must not be collapsed, and the keyed default stays
 * `'external-client'`: full scope is reachable only by a declared key mode
 * (`api_keys.anonymous_context='full'`, an owner opt-in at creation with the
 * chat-link trust posture). Handing it out by default would reopen the
 * cross-client read the 2026-08-07 client-principal work closed; keeping the
 * chat link thin is what made it a persona with an empty brain.
 */
export type PublicTurnContextScope = 'external-client' | 'assistant-full' | 'internal-member'

/**
 * Does this lane read the brain system-side (`AccessContext.systemRead`),
 * bypassing member RLS and leaning entirely on `buildAccessPredicate`?
 *
 * Exactly one lane may. `assistant-full` runs as a synthetic principal that
 * holds no `workspace_members` row, so member RLS hid every row before the
 * clearance ladder was consulted — the lane raised the application ceiling and
 * left the database gate shut, which is why a chat link answered from an empty
 * brain on 2026-08-07. The pinned assistant clearance is the containment.
 *
 * The other two must NOT, for opposite reasons:
 *  • `external-client` — its `public` floor plus the `client:*` compartment
 *    wall are the cross-client isolation contract. Opening it re-opens the
 *    cross-client read that work closed.
 *  • `internal-member` — the actor is a REAL member, so ordinary RLS already
 *    passes. Bypassing it would silently widen a member past their own
 *    `min(member, assistant)` ceiling.
 *
 * Extracted as a named predicate because collapsing these lanes is the
 * recurring mistake this file keeps having to defend against. READ paths only:
 * writes stay on `queryWithRLS` under the synthetic principal, which is what
 * keeps "external chat has no write access" enforced by the database.
 */
export function laneReadsSystemSide(scope: PublicTurnContextScope | undefined): boolean {
  return scope === 'assistant-full'
}

/**
 * Turn-scoped identity attested by the consumer's backend. Never persisted
 * as authority — see `claimsSchema` in `public-api.ts`. The chat-link caller
 * never sends these (its visitors are anonymous by construction).
 */
export type PublicTurnClaims = {
  email?: string
  orgId?: string
  roles?: string[]
}

/** The validated turn request — the caller owns schema validation. */
export type PublicTurnBody = {
  externalUserId: string
  externalUserName?: string
  /** Back-compat alias of `claims.email`; the route rejects a mismatch. */
  externalUserEmail?: string
  identified?: boolean
  claims?: PublicTurnClaims
  /** Consumer-attested per-turn account context. Turn-scoped, never stored. */
  endUserContext?: string
  /**
   * Deterministic authenticated-client memory upsert. Accepted only for an
   * identified external principal on an internal-or-higher, non-primary
   * assistant. The server owns the internal sensitivity + exact client
   * compartment stamp; callers cannot supply either.
   */
  clientMemory?: {
    key: string
    summary: string
    detail?: string
    tags?: string[]
  }
  /** Deterministic CRM handoff; contact + lead are ensured transactionally. */
  clientLead?: {
    key: string
    name?: string
  }
  /** Public-research-key tools are withheld unless this turn opts in. */
  allowPublicResearch?: boolean
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
  /**
   * How much assistant context to reconstruct. Defaults to
   * `'external-client'` so the keyed API keeps its existing behavior
   * without naming the field. See `PublicTurnContextScope`.
   */
  contextScope?: PublicTurnContextScope
  /**
   * Internal-lane actor resolution. Set only by the keyed route for
   * `audience='internal'` keys (docs/plans/api-chat-modes.md §3 D4):
   * `email` is the per-request attribution; when null the turn runs as
   * `defaultUserId` - the key's creator. Either way the resolved user
   * must be a member of the assistant's workspace or the turn fails
   * with 403 `actor_not_member`.
   */
  internalActor?: { email: string | null; defaultUserId: string | null }
  /** Immutable per-key capability ceiling. Chat links omit it. */
  toolPolicy?: 'assistant' | 'public_research'
  /** JSON remains the default. SSE streams the same query loop when the keyed
   * route receives an explicit `Accept: text/event-stream`. */
  delivery?: 'json' | 'sse'
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
  | 'actor_not_member'
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

export type PublicTurnSseSender = (event: string, data: unknown) => void

/** Open the public assistant SSE response with the same anti-buffering headers
 * as the authenticated web chat. Exported so the wire format is unit-tested. */
export function openPublicTurnSse(
  res: import('express').Response,
): PublicTurnSseSender {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  return (event, data) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
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

/**
 * The end-user identity block for a public turn, as private runtime context.
 *
 * Two rules govern where this lands, and they pull in opposite directions.
 *
 * It must reach the model, because otherwise the assistant does not know it
 * is serving a customer rather than a teammate: it has no name to use, no
 * signal that the person is unauthenticated, and no account context. That is
 * the gap the 2026-08-06 audit named as "the model is never told who it is
 * talking to".
 *
 * And it must NOT ride on the user turn. The caller routes the returned
 * string through `formatPrivateRuntimeContext` into the trusted system
 * channel. On 2026-08-01 a vague question resolved against hidden
 * application metadata that had been moved into a user-role tail for cache
 * reasons and the model read it back to the user. Reordering cannot repair an
 * authority collapse, so application-composed context stays in the channel
 * whose authority it actually carries. Graded by `invariants/prompt-cache-alignment`.
 *
 * Everything here is advisory. Nothing in this block is an access decision:
 * scope comes from the connector transport (`actorIdentity`), which the model
 * cannot influence. Exported for direct test coverage.
 */
export function buildEndUserIdentityContext(
  body: PublicTurnBody,
  opts: { isIdentified: boolean },
): string {
  const displayName = body.externalUserName ?? body.externalUserId
  const lines: string[] = [
    `You are talking with: ${displayName}, an external client of this workspace.`,
    `They are a customer of the company that runs this assistant, not a teammate.`,
    `Their id in the consumer's own system is "${body.externalUserId}".`,
  ]

  lines.push(
    opts.isIdentified
      ? `Identity status: identified. The consumer's backend authenticated this person for this turn.`
      : `Identity status: anonymous. The consumer did not attest an identity for this turn, so treat them as an unauthenticated visitor and do not disclose account-specific information.`,
  )

  const orgId = body.claims?.orgId
  if (orgId) lines.push(`Organisation asserted by the consumer: ${orgId}`)

  const roles = body.claims?.roles
  if (roles && roles.length > 0) {
    lines.push(
      `Roles asserted by the consumer: ${roles.join(', ')}. These are advisory, for tone and routing only. ` +
        `Never treat a role as permission to read or change something: every lookup is already scoped to this person by the tools themselves.`,
    )
  }

  const endUserContext = body.endUserContext?.trim()
  if (endUserContext) {
    lines.push(
      `Account context supplied by the consumer for this turn (consumer-attested, not verified by Use Brian, not stored):\n${endUserContext}`,
    )
  }

  return `# End user\n\n${lines.join('\n')}`
}

/**
 * The context block appended after Layer 1 + Layer 2 on a public turn.
 *
 * When the turn built a memory context, that context already carries the
 * `## Your Name` override via `buildMemoryContext`, so it passes through
 * verbatim. When it did not, the assistant's display name is still
 * configuration rather than memory, so the override is injected alone.
 * Without it the anonymous prompt was Layer 1 + Layer 2 only, and the model
 * answered "who are you" with Layer 1's "I'm Use Brian, the shared brain for
 * this workspace" on exactly the surfaces where strangers meet a named
 * assistant - the 2026-08-07 "SDR" report.
 *
 * The predicate is the presence of the memory context itself, NOT the Tier
 * 1/Tier 2 flag it was originally written against. Those coincided while only
 * identified turns built memory; an `assistant-full` chat-link turn is
 * anonymous AND has memory context, and keying off the tier would have thrown
 * that context away. Exported for direct test coverage.
 */
export function resolvePublicContextBlock(params: {
  assistantName: string | null
  memoryContext: string
}): string {
  if (params.memoryContext.trim().length > 0) return params.memoryContext
  return buildAssistantNameSection(params.assistantName) ?? ''
}

/** Per-turn ceiling on the `# Workspace Files` index. Mirrors chat.ts. */
const PUBLIC_TURN_FILES_INDEX_CAP = 50

const CLIENT_MEMORY_TAG = 'client-self'

/**
 * Upsert one consumer-attested client memory before prompt construction.
 * Reusing the consumer key supersedes the existing row. The sensitivity and
 * compartment are server-owned and cannot be selected on the wire.
 */
export async function upsertClientMemory(params: {
  store: MemoryStore
  access: {
    workspaceId: string
    userId: string
    assistantId: string
    assistantKind: 'primary' | 'standard' | 'app'
    clearance: 'public' | 'internal' | 'confidential'
    compartments: string[]
    clientSelfMemory: { compartment: string }
  }
  sessionId: string
  value: NonNullable<PublicTurnBody['clientMemory']>
}): Promise<void> {
  const keyTag = `client-memory:${params.value.key}`
  const callerTags = (params.value.tags ?? []).filter(
    (tag) => tag !== CLIENT_MEMORY_TAG && !tag.startsWith('client-memory:'),
  )
  const tags = Array.from(new Set([
    CLIENT_MEMORY_TAG,
    keyTag,
    ...callerTags,
  ]))
  const existing = (await params.store.getIndex(params.access, true))
    .find((memory) => memory.tags.includes(keyTag))
  if (existing) {
    const updated = await params.store.update(existing.id, {
      summary: params.value.summary,
      detail: params.value.detail,
      tags,
    }, params.access)
    if (updated) return
  }
  await params.store.create({
    assistantId: params.access.assistantId,
    userId: params.access.userId,
    scope: 'shared',
    tags,
    summary: params.value.summary,
    detail: params.value.detail,
    source: 'user',
    sourceSessionId: params.sessionId,
    workspaceId: params.access.workspaceId,
    sensitivity: 'internal',
    compartments: [params.access.clientSelfMemory.compartment],
    createdByUserId: params.access.userId,
    createdByAssistantId: params.access.assistantId,
  })
}

/**
 * Apply the immutable key ceiling and the per-turn research-consent gate.
 * Returning true tells the caller to skip MCP injection entirely.
 */
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
  //
  // `claims.email` and `externalUserEmail` are one field with two spellings
  // (the route 400s on a mismatch), so collapse them here and let the rest of
  // the pipeline see a single email. Either one implies Tier 1: "email
  // asserts a real person" is the existing semantic, and giving the newer
  // spelling different tier behavior would be the footgun.
  const claimedEmail = body.claims?.email ?? body.externalUserEmail
  const wantsIdentified = body.identified === true || !!claimedEmail
  const internalScope = input.contextScope === 'internal-member'
  let user
  let isIdentified = false
  if (internalScope) {
    // Internal lane (D4): the actor is a REAL workspace member, never a
    // shadow. Per-request attribution by email, defaulting to the key's
    // creator. Membership is validated against the assistant's workspace -
    // an internal key must not be usable to act as an arbitrary platform
    // user, and a departed member's key attribution fails closed.
    const actor = input.internalActor
    const resolved = actor?.email
      ? await findUserByEmail(actor.email)
      : actor?.defaultUserId
        ? await findUserById(actor.defaultUserId)
        : null
    if (!resolved || !assistant.workspaceId) {
      return fail(res, 403, 'actor_not_member')
    }
    const membership = await getWorkspaceMembershipSystem(resolved.id, assistant.workspaceId)
    if (!membership) {
      return fail(res, 403, 'actor_not_member')
    }
    user = resolved
    // Member-grade turn: memory tools on, as this member (same as web chat).
    isIdentified = true
  } else {
    // External lane: the shared resolver is also used by principal-bound
    // workflows, so the shadow namespace and Tier-1 semantics cannot drift
    // between HTTP and background execution.
    const resolved = await resolveExternalClientIdentity({
      identityNamespace: input.identityNamespace,
      externalUserId: body.externalUserId,
      externalUserName: body.externalUserName,
      claimedEmail,
      identified: wantsIdentified,
    })
    user = resolved.user
    isIdentified = resolved.identified
  }

  const externalPrincipal = !internalScope && isExternalPrincipal(user)
  const clientSelfMemory = resolveClientSelfMemory({
    isExternal: externalPrincipal,
    isIdentified,
    assistantKind: assistant.kind,
    assistantClearance: assistant.clearance,
    workspaceId: assistant.workspaceId ?? null,
    externalUserId: body.externalUserId,
  })
  if (body.clientMemory && !clientSelfMemory) {
    return fail(
      res,
      400,
      'invalid_input',
      'clientMemory requires an identified external client and a non-primary assistant with internal clearance',
    )
  }
  if (body.clientLead && (!externalPrincipal || !isIdentified || !claimedEmail || !assistant.workspaceId)) {
    return fail(
      res,
      400,
      'invalid_input',
      'clientLead requires an identified external client with a verified email and workspace',
    )
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

  // ── 4b. Client accrual ───────────────────────────────────
  // What this turn leaves behind about the external client it serves: the
  // `client:<externalUserId>` compartment stamp (the client-vs-client wall,
  // D12) and, on an identified turn, a team-visible contact record (D11).
  // Returns an empty stamp for a resolved teammate, so a public-API turn on
  // behalf of a real member behaves exactly as before. See client-accrual.ts.
  //
  // The internal lane skips the call outright rather than relying on the
  // teammate no-op inside it: an attributed member is a principal, not a
  // client, and the skip should be legible at the seam.
  const accrual = internalScope
    ? { compartments: [], contactEntityId: null }
    : await accrueClientPrincipal({
        user,
        workspaceId: assistant.workspaceId ?? null,
        assistantId: assistant.id,
        identityNamespace: input.identityNamespace,
        externalUserId: body.externalUserId,
        externalUserName: body.externalUserName,
        email: claimedEmail ?? null,
        orgId: body.claims?.orgId ?? null,
        identified: isIdentified,
        clientLead: body.clientLead,
        analytics: deps.analytics,
        ownerId,
      })

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
  // Both public front doors bill the assistant's owner, so their tier is
  // settable independently of the owner's own bot: `api_model_alias`
  // (migration 416). Before that these turns rode `telegram_model_alias`,
  // which meant capping a public chat link also downgraded Telegram.
  const { logicalModel, logicalTier, servingModel: model } = resolveChatModelSelection(
    assistant.apiModelAlias,
    workspacePlan,
    budgetStatus,
    deps.configuredProviders,
  )
  const customLlmRuntime = assistant.workspaceId && deps.resolveWorkspaceCustomLlm
    ? await deps.resolveWorkspaceCustomLlm({
        workspaceId: assistant.workspaceId,
        requestedTier: logicalTier,
        allowDefault: true,
      })
    : null
  const backgroundLlmRuntime = assistant.workspaceId && deps.resolveWorkspaceCustomLlm
    ? await deps.resolveWorkspaceCustomLlm({
        workspaceId: assistant.workspaceId,
        requestedTier: 'standard',
        allowDefault: true,
        allowAnyDefault: true,
      })
    : null
  const turnProvider = customLlmRuntime?.provider ?? deps.provider

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
  const fullScope = input.contextScope === 'assistant-full'
  const activeCapabilities = new Set(
    await deps.capabilityStore.listActive(assistant.id),
  )
  const baseTools = filterToolsByCapabilities(new Map(deps.tools), activeCapabilities)
  const limitedPublicResearch = applyPublicResearchToolCeiling({
    tools: baseTools,
    toolPolicy: input.toolPolicy,
    internalScope,
    allowPublicResearch: body.allowPublicResearch === true,
  })

  const connectorUserId = await getConnectorUserId(user.id, assistant.workspaceId ?? null)
  // Read-side clearance (incident 2026-06-01): read ceiling =
  // min(member, assistant). The API key's principal is typically the
  // workspace owner (resolves to the assistant's clearance), but a
  // lower-clearance principal is correctly bounded. Writes keep the
  // assistant's clearance via `assistantClearance` on the context.
  //
  // `assistant-full` deliberately skips the membership floor. A chat-link
  // visitor is a non-member, so the floor resolved every read to `public` —
  // and every brain table defaults to `sensitivity='internal'`, so the link
  // matched almost nothing and shipped as a persona with an empty brain. The
  // owner is publishing THEIR assistant, so the assistant's own clearance is
  // the ceiling, exactly as it is on any channel the owner speaks through.
  //
  // This makes `assistants.clearance` the security control for the link: point
  // one at a `confidential` assistant and that content is readable by anyone
  // holding the URL. The Studio create-link flow states the inherited
  // clearance for that reason — see docs/architecture/features/public-chat-link.md.
  const { clearance: readClearance, compartments: readCompartments } = fullScope
    ? { clearance: assistant.clearance, compartments: assistant.compartments }
    : await resolveReadCeilingsSystem(
        user.id,
        assistant.workspaceId ?? null,
        assistant.clearance,
        assistant.compartments,
      )
  const mcpInjection = limitedPublicResearch
    ? {
        enrichConfirmation: async (_toolName: string, toolInput: Record<string, unknown>) => toolInput,
        unavailable: [] as string[],
      }
    : await applyMcpInjection({
        scope: 'public-api',
        connectorUserId,
        assistant: { id: assistant.id, workspaceId: assistant.workspaceId ?? null },
        userTimezone: owner.timezone ?? undefined,
        tools: baseTools,
        stores: deps,
        engineHooks: deps.engineHooks,
        // End-user identity on the wire. A consumer serving its own clients
        // points this assistant at a bridge MCP server; the bridge maps
        // `X-UseBrian-Actor-Id` back to its own user record and scopes every
        // fetch to that person. Without it the bridge cannot tell one client
        // from another and the scoping has to be attempted in the prompt,
        // which is not a guarantee.
        //
        // `id` is the consumer's own opaque `externalUserId` — the value the
        // bridge already indexes on — while `userId` is the stable Use Brian
        // UUID that survives the same human arriving on another channel.
        // Server-resolved from the authenticated key, never from model output;
        // the `X-UseBrian-*` namespace is unsettable from user connector config
        // (`preflightHeadersToRecord`) and merges at highest precedence, so
        // neither the model nor the end user can forge it. Still opt-in per
        // connector via `config.sendActorIdentity`.
        //
        // `roles` is deliberately absent: identity is forwarded, authorization
        // is derived. See `ActorIdentity.org`.
        actorIdentity: {
          channel: 'api',
          id: body.externalUserId,
          // Internal lane: the actor is the resolved member, so the wire carries
          // their real email (the tier fields that feed claimedEmail are rejected
          // at the route for internal keys).
          email: internalScope ? (user.email ?? null) : (claimedEmail ?? null),
          userId: user.id,
          org: body.claims?.orgId ?? null,
        },
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

  // Memory tools. `saveMemory` is Tier 1 only — an anonymous stranger must
  // never write into the workspace brain, and on `assistant-full` that is the
  // one capability deliberately withheld from an otherwise complete surface.
  //
  // The write bar is structural, not just this branch: `listMemoryUsers`
  // applies `excludeExternalPrincipalsSql` and `chatlink:` is an
  // external-principal namespace, so background consolidation cannot turn a
  // visitor's session into memories either. Withholding the tool is therefore
  // sufficient; there is no second write path to close.
  const memoryViewerCtx = {
    workspaceId: assistant.workspaceId ?? '',
    userId: user.id,
    assistantId: assistant.id,
    assistantKind: assistant.kind,
    clearance: readClearance,
    compartments: readCompartments,
    clientSelfMemory: clientSelfMemory ?? undefined,
    systemRead: laneReadsSystemSide(input.contextScope) || undefined,
  }
  if (body.clientMemory && clientSelfMemory) {
    await upsertClientMemory({
      store: deps.memoryStore,
      access: {
        ...memoryViewerCtx,
        workspaceId: assistant.workspaceId!,
        compartments: readCompartments ?? [],
        clientSelfMemory,
      },
      sessionId: session.id,
      value: body.clientMemory,
    })
  }

  const { saveMemory, getMemory } = createMemoryTools(deps.memoryStore)
  if (isIdentified && (!externalPrincipal || clientSelfMemory)) {
    baseTools.set('saveMemory', saveMemory)
  }
  if (isIdentified || fullScope) {
    baseTools.set('getMemory', getMemory)
  }

  // ── 9. Memory context ────────────────────────────────────
  // Built for an identified caller, and for every `assistant-full` turn
  // regardless of tier: the visitor's own shadow soul is empty, but the
  // workspace/team memory is the assistant's knowledge of its own company and
  // is the substance of what the link is meant to expose.
  let memoryContext = ''
  if (isIdentified || fullScope) {
    const [soul, identityMemories, memoryIndex, workspaceIdentityMemories, teamMemoryIndex] =
      await Promise.all([
        deps.memoryStore.getSoul(assistant.id, user.id, 'Use Brian'),
        deps.memoryStore.getIdentity(memoryViewerCtx),
        deps.memoryStore.getIndex(memoryViewerCtx),
        // Team memory is what makes a full-scope link useful, and what makes
        // the internal lane a colleague rather than a stranger; the external
        // keyed lanes stay on their per-user projection.
        (fullScope || internalScope) && assistant.workspaceId
          ? deps.memoryStore.getWorkspaceIdentity(memoryViewerCtx)
          : Promise.resolve([]),
        (fullScope || internalScope) && assistant.workspaceId
          ? deps.memoryStore.getWorkspaceIndex(memoryViewerCtx)
          : Promise.resolve([]),
      ])
    memoryContext = buildMemoryContext({
      soul,
      identityMemories: identityMemories.map((m) => ({ id: m.id, summary: m.summary, detail: m.detail })),
      memoryIndex: memoryIndex.map((m) => ({ ...m, appId: null })),
      workspaceIdentityMemories: workspaceIdentityMemories.map((m) => ({
        id: m.id,
        summary: m.summary,
        detail: m.detail,
      })),
      teamMemoryIndex: teamMemoryIndex.map((m) => ({ ...m, appId: null })),
      assistantName: assistant.name,
    })
  }

  // ── 9b. Ambient workspace context (assistant-full + internal-member) ──
  // The blocks web chat carries and the thin public turn never had. Each is
  // independently optional and failure-tolerant: a store that is not wired in
  // (OSS, or a caller that never passes it) simply omits its block. The
  // internal lane gets them member-bounded: the files index reads through
  // `readClearance`/`readCompartments`, which for a member is min(member,
  // assistant) rather than the assistant override full scope uses.
  let workspaceFilesContext: string | null = null
  let brandContext: string | null = null
  let sessionStateBlock: string | null = null
  let skillsFragment = ''
  if (fullScope || internalScope) {
    if (deps.workspaceFilesStore && assistant.workspaceId && activeCapabilities.has('files')) {
      try {
        const rows = await deps.workspaceFilesStore.listIndexRanked(
          {
            workspaceId: assistant.workspaceId,
            userId: user.id,
            assistantId: assistant.id,
            assistantKind: assistant.kind,
            clearance: readClearance,
            compartments: readCompartments,
            systemRead: laneReadsSystemSide(input.contextScope) || undefined,
          },
          PUBLIC_TURN_FILES_INDEX_CAP,
        )
        workspaceFilesContext = buildWorkspaceFilesContext(rows)
      } catch (err) {
        console.error('[public-turn] workspace-files index fetch failed:', err)
      }
    }

    brandContext = await resolveBrandContext({
      userId: ownerId,
      workspaceId: assistant.workspaceId,
      hasCapability: activeCapabilities.has('brand'),
      logLabel: 'public-turn',
    })

    if (deps.sessionStateStore) {
      try {
        sessionStateBlock = await buildSessionStateBlock({
          store: deps.sessionStateStore,
          sessionId: session.id,
        })
      } catch (err) {
        console.error('[public-turn] session-state block fetch failed:', err)
      }
    }

    if (deps.skillStore) {
      try {
        const skillResult = await injectSkills({
          skillStore: deps.skillStore,
          connectorUserId,
          assistantId: assistant.id,
          // §5.5 governance gate — the assistant's clearance bounds which
          // workspace skills are offered, same as every other channel.
          assistantClearance: assistant.clearance,
          tools: baseTools,
          connectorStore: deps.connectorStore,
          unavailableCapabilities: mcpInjection.unavailable,
          channel: 'api',
          assistantKind: assistant.kind,
          workspaceId: assistant.workspaceId ?? undefined,
        })
        skillsFragment = skillResult.promptFragment
      } catch (err) {
        console.error('[public-turn] skill injection failed:', err)
      }
    }

    // Skills inject their own tools, so re-run the confirmation strip: this
    // surface still has no approval loop. Ordering matters — the earlier strip
    // ran before injectSkills existed on this path.
    for (const [, tool] of baseTools) {
      if (tool.requiresConfirmation) {
        baseTools.delete(tool.name)
      }
    }
  }

  // The assistant-name override rides the memory context when one was built,
  // and is injected alone otherwise - see `resolvePublicContextBlock`.
  const contextBlock = resolvePublicContextBlock({
    assistantName: assistant.name,
    memoryContext,
  })
  // End-user identity is private runtime context on the external lanes — the
  // trusted system channel, never the user turn. See
  // `buildEndUserIdentityContext`. The internal lane replaces it with the
  // member speaker line: an attributed member is a teammate speaking, not "an
  // external client of this workspace", and the wrong framing would make the
  // model treat its own colleague as an unauthenticated stranger.
  const endUserContext = internalScope ? '' : buildEndUserIdentityContext(body, { isIdentified })

  let fullSystemPrompt: string
  // Representations of content the visitor can actually see. Empty on this
  // surface today (no reply quotes, no open page), but the three-way split
  // contract is wired rather than assumed: an authority collapse is not
  // repairable by reordering, so the seam exists before it has a payload.
  // See `invariants/prompt-cache-alignment`.
  let userVisibleContext = ''
  if (fullScope || internalScope) {
    // Route through the shared builder so the chat link inherits the same
    // block order and the same provenance split as every other channel,
    // rather than growing a second hand-rolled assembly that drifts.
    //
    // Timezone: the internal lane has a real member with a real timezone;
    // the anonymous full-scope link falls back to the workspace owner's (the
    // visitor's is unknown and the browser sends none on this surface).
    // Naming the assistant's own zone is the honest answer, and it is
    // strictly better than the previous state, where no date reached the
    // model at all and it guessed.
    const timezone =
      (internalScope ? user.timezone : null) ?? owner.timezone ?? 'UTC'
    const split = buildSplitSystemPrompt({
      basePrompt: deps.systemPrompt,
      charter: resolveCharter(assistant),
      playbookRules: await listActivePlaybookRules(assistant.id).catch((err) => {
        console.error('[public-turn] playbook rules fetch failed:', err)
        return []
      }),
      memoryContext: contextBlock,
      workspaceFilesContext,
      brandContext,
      skillsFragment,
      sessionStateBlock,
      currentDateTime: new Date().toLocaleString('en-US', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }),
      timezone,
      unavailableCapabilitiesPrompt: buildUnavailableCapabilitiesPrompt(
        mcpInjection.unavailable,
        baseTools,
      ),
      // Internal lane: the same "You are talking with:" lead line web chat
      // ships (web-chat speaker identity, 08-06) — the actor is a member.
      speakerIdentity: internalScope
        ? { name: user.name ?? user.email ?? 'Workspace member', email: user.email }
        : undefined,
      // Ordered last among the builder's private-runtime sections, so the
      // end-user identity block stays at the end of the envelope as before.
      // Empty (and omitted by the builder) on the internal lane.
      preflightContext: endUserContext,
    })
    const privateBlock = formatPrivateRuntimeContext(split.privateRuntimeContext)
    fullSystemPrompt = privateBlock
      ? `${split.stablePrompt}\n\n${privateBlock}`
      : split.stablePrompt
    userVisibleContext = split.userVisibleContext
  } else {
    // Same Layer 2 the shared builder renders: the charter block (with
    // admitted playbook rules), not the raw legacy column (which a
    // post-418 write no longer updates).
    const playbookRules = await listActivePlaybookRules(assistant.id).catch((err) => {
      console.error('[public-turn] playbook rules fetch failed:', err)
      return [] as string[]
    })
    const charterBlock = renderCharterBlock(resolveCharter(assistant), { playbookRules })
    const assistantSystemPrompt = charterBlock
      ? `${deps.systemPrompt}\n\n${charterBlock}`
      : deps.systemPrompt
    const promptWithMemory = contextBlock
      ? `${assistantSystemPrompt}\n\n${contextBlock}`
      : assistantSystemPrompt
    // Append the unavailable-capabilities block so the model doesn't
    // burn turns hunting for tools that aren't connected. Same pattern
    // as chat.ts (line 1124).
    const promptWithCapabilities =
      promptWithMemory + buildUnavailableCapabilitiesPrompt(mcpInjection.unavailable, baseTools)
    const identityBlock = formatPrivateRuntimeContext(endUserContext)
    fullSystemPrompt = identityBlock
      ? `${promptWithCapabilities}\n\n${identityBlock}`
      : promptWithCapabilities
  }

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
    tier: modelToCompactionTier(logicalModel),
    channelClass: 'web',
    profile: 'linear',
    provider: backgroundLlmRuntime?.provider ?? deps.provider,
    model: backgroundLlmRuntime?.selector,
    inputTokenLimit: backgroundLlmRuntime?.inputTokenLimit,
    modelTier: 'standard',
    providerKeySource: backgroundLlmRuntime?.providerKeySource ?? 'platform',
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

  // User-visible context rides the newest USER turn, never the system channel
  // — the third leg of the provenance split. `attachUserVisibleContext`
  // returns null when no plain trailing user message can carry it (a
  // tool_result carrier, an assistant-final resume shape); the documented
  // fallback is in-prompt placement for that turn only.
  if (userVisibleContext) {
    const enveloped = attachUserVisibleContext(messages, userVisibleContext)
    if (enveloped) {
      messages = enveloped
    } else {
      fullSystemPrompt = `${fullSystemPrompt}\n\n${formatUserVisibleContext(userVisibleContext)}`
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
  const sendEvent = input.delivery === 'sse' ? openPublicTurnSse(res) : null
  sendEvent?.('session', { sessionId: channelId })

  let responseText = ''
  let totalUsage: TokenUsage | null = null
  let responseModel: string | null = null
  let assistantMessageId: string | null = null

  try {
    for await (const event of queryLoop({
      provider: turnProvider,
      model,
      maxTokens: customLlmRuntime?.maxTokens,
      inputTokenLimit: customLlmRuntime?.inputTokenLimit,
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
        // Memory-only authenticated-client carve-out. Other tools ignore this
        // field and continue to receive the public/empty general projection.
        clientSelfMemory: clientSelfMemory ?? undefined,
        memoryWriteSensitivityFloor: clientSelfMemory ? 'internal' : undefined,
        memoryWriteCompartments: clientSelfMemory
          ? [clientSelfMemory.compartment]
          : undefined,
        assistantClearance: assistant.clearance,
        assistantCompartments: assistant.compartments,
        // Every CRM / memory / task / knowledge write on this turn unions this
        // in (`unionCompartments(accumulator, assistantDefaultCompartments)`),
        // so adding the client's compartment here stamps the whole turn from
        // one seam. Empty for a teammate — see client-accrual.ts.
        assistantDefaultCompartments: unionCompartments(
          assistant.defaultCompartments,
          accrual.compartments,
        ),
        workspaceId: assistant.workspaceId ?? undefined,
        workerRuntime: customLlmRuntime
          ? {
              provider: customLlmRuntime.provider,
              model: customLlmRuntime.selector,
              modelTier: customLlmRuntime.modelTier,
              providerKeySource: customLlmRuntime.providerKeySource,
              inputTokenLimit: customLlmRuntime.inputTokenLimit,
              maxTokens: customLlmRuntime.maxTokens,
            }
          : undefined,
        assistantKind: assistant.kind,
        // `assistant-full` runs as a synthetic non-member principal, so member
        // RLS hid every brain row before `clearance` was ever consulted — the
        // lane raised the application ceiling and left the database gate shut,
        // which is why a chat link read an empty brain (2026-08-07). Reads go
        // system-side with `buildAccessPredicate` as the whole gate; the pinned
        // `readClearance` above is the containment.
        //
        // Reads ONLY. Writes stay on `queryWithRLS` under this same synthetic
        // principal and the database still refuses them, which is what keeps
        // "external chat has no write access" enforced below the tool layer.
        // Never set this for `external-client`: that lane's `public` floor and
        // `client:*` compartment wall are the cross-client isolation contract.
        systemRead: laneReadsSystemSide(input.contextScope) || undefined,
        userTimezone:
          (internalScope ? user.timezone : null) ?? owner.timezone ?? undefined,
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
        sendEvent?.('text_delta', { text: event.text })
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
        if (sendEvent) {
          sendEvent('error', { error: 'upstream_failed', detail: event.error?.message })
          sendEvent('done', {})
          res.end()
          return
        }
        return fail(res, 502, 'upstream_failed', event.error?.message)
      }
    }
  } catch (err) {
    console.error('[public-turn] query loop threw:', err)
    if (sendEvent) {
      sendEvent('error', { error: 'upstream_failed', detail: (err as Error).message })
      sendEvent('done', {})
      res.end()
      return
    }
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
    const cost = customLlmRuntime?.providerKeySource === 'user'
      ? 0
      : calculateCost(responseModel, totalUsage)
    deps.usageStore.recordUsage({
      userId: ownerId,
      actorUserId: user.id,
      assistantId: assistant.id,
      sessionId: session.id,
      model: responseModel,
      modelTier: logicalTier,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      cacheReadTokens: totalUsage.cacheReadTokens,
      cacheWriteTokens: totalUsage.cacheWriteTokens,
      actualCostUsd: cost,
      source: 'api',
      userMessageId: storedUserMsg.id,
      triggerKey: 'main_response',
      providerKeySource: customLlmRuntime?.providerKeySource ?? 'platform',
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

  const finalMessageId = assistantMessageId ?? randomUUID()
  const finalModel = responseModel ?? model
  if (sendEvent) {
    sendEvent('turn_complete', {
      sessionId: channelId,
      messageId: finalMessageId,
      model: finalModel,
    })
    sendEvent('done', {})
    res.end()
    return
  }

  // Strip any model scaffolding / meta-commentary — synchronous programmatic
  // consumers have no client render layer to do it (see sanitizeDeliveryText).
  const trimmed = sanitizeDeliveryText(responseText)
  res.json({
    sessionId: channelId,
    messageId: finalMessageId,
    reply: trimmed.length > 0 ? trimmed : "I couldn't generate a reply — please rephrase or try again.",
    model: finalModel,
  })
}

export type PublicHistoryInput = {
  assistantId: string
  identityNamespace: string
  externalUserId: string
  sessionId?: string
  limit: number
  /**
   * Internal-lane override: the sessions belong to a REAL member user, not
   * a shadow, so the shadow lookup below would find nothing. The keyed GET
   * resolves the actor (same rules as the POST) and passes the id here.
   */
  resolvedUserId?: string
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
  const user = input.resolvedUserId
    ? { id: input.resolvedUserId }
    : await findUserByAuthProvider('channel', authProviderId)
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
