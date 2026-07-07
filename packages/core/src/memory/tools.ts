import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { MODEL_HIDDEN_PARAM_MARKER } from '../engine/query-loop.js'
import { decideMemoryScope } from '../classification/rules/memory-scope/index.js'
import type { MemoryStore } from './types.js'
import { createHash } from 'node:crypto'
import type { AccessContext } from '../security/access-context.js'
import type { Sensitivity } from '../security/sensitivity.js'
import { researchWriteFloor } from '../security/sensitivity.js'
import { unionCompartments } from '../security/compartments.js'
import { looksLikeCronOperationalState } from '../consolidation/phases.js'
import type { EntityStore, EntityLinksStore } from '../entities/types.js'
import { applyExplicitLinks, explicitLinksField, formatLinksSummary } from '../entities/explicit-links.js'
import type { MemoryRecallBuffer } from './recall-buffer.js'

/**
 * Build an `AccessContext` from the live `ToolContext`. The four-axis
 * viewer projection (workspace + user + assistant + clearance) flows
 * straight from the chat-tool context; `workspaceId` falls back to the
 * empty string for legacy contexts where the assistant has no workspace
 * row — the universal predicate then matches nothing, which is the
 * desired safe-failure mode.
 *
 * `assistantKind` defaults to `'standard'` when the ToolContext
 * predates the kind split; this preserves the non-primary partition
 * for legacy callers (safe-failure: hides more, never widens by
 * mistake).
 */
function viewerCtx(context: ToolContext): AccessContext {
  return {
    workspaceId: context.workspaceId ?? '',
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

/**
 * CRM-note anchor kinds. Per `docs/architecture/brain/corrections.md`
 * §"CRM notes via memory" (SV(2) 2026-05-14), per-entity notes lock to
 * the entities that mirror CRM rows — `person` / `company` / `deal`.
 * Other entity kinds (project, product, tenant-namespace) are not in
 * scope for the note primitive: they have their own primary anchors.
 */
const CRM_NOTE_ENTITY_KINDS = new Set(['person', 'company', 'deal'])

/**
 * Reject write payloads whose summary or detail matches the operational-
 * state regex set (Nth follow-up, N overdue, awaiting confirmation, Nth
 * check, follow-up sent/scheduled/fired). These phrasings capture per-cycle
 * status, not durable facts — persisting them lets stale deltas re-prime
 * the topic on every turn's memory index. See
 * `packages/core/src/consolidation/phases.ts` → CRON_OPERATIONAL_PATTERNS
 * and the 2026-04-22 / 2026-04-23 Cynthia incidents in
 * `docs/architecture/context-engine/memory-consolidation.md`.
 *
 * Scans summary + detail together so a benign summary ("Pill reminder
 * completed") cannot smuggle operational phrasing ("2.5 hours overdue")
 * into a detail field that downstream prune passes never look at.
 */
function rejectOperationalStatePayload(
  summary: string | undefined,
  detail: string | null | undefined,
): string | null {
  const blob = [summary ?? '', detail ?? ''].filter(Boolean).join('\n')
  if (!blob) return null
  if (looksLikeCronOperationalState(blob)) {
    return (
      'Refusing to save operational-state phrasing (e.g. "Nth follow-up", "Nm overdue", "awaiting confirmation"). ' +
      'Store the absolute event instead ("Pill reminder fired at 14:30 HKT") or call trackCommitment / updateScheduledJob to record the state on its structured tier. ' +
      'Relative deltas captured in memory age out the moment they are written and re-prime the topic every turn.'
    )
  }
  return null
}

/** Callback for memory tool analytics events */
export type MemoryToolEvent =
  | { type: 'memory_created'; source: 'model'; memoryType: string }
  | { type: 'memory_updated'; memoryId: string }
  | { type: 'memory_retrieved'; source: 'id' | 'search'; resultCount: number; query?: string }
  | { type: 'memory_deleted'; memoryId: string }

export type MemoryToolOptions = {
  onEvent?: (event: MemoryToolEvent) => void
  /** User's plan — used for memory cap enforcement (free: 20 max). */
  userPlan?: string
  /**
   * Entity-side stores that enable the CRM-note path on saveMemory
   * (WU-6.12, `docs/architecture/brain/corrections.md` §"CRM notes via
   * memory"). When both are wired, `saveMemory` accepts an `entityId`
   * param that auto-tags the memory `note` and creates an entity_links
   * row of shape `{source_kind:'memory', target_kind:'entity',
   * edge_type:'mentioned'}`. When either is absent the param surfaces a
   * clean error rather than silently dropping the link. Both must be
   * supplied together — half-wiring would create memories with no
   * anchor.
   */
  entityStore?: EntityStore
  entityLinksStore?: EntityLinksStore
  /**
   * Per-turn buffer that queues `tool_call`-kind recall events so the
   * chat route can flush them with the assistant message id once the
   * turn commits. When unset, the tool falls back to the legacy
   * `store.trackRecall` aggregate-counter update only — the recall is
   * still counted on `memories.recall_count`, but no row lands in
   * `memory_recall_events` (no JOIN to feedback).
   *
   * See `docs/architecture/context-engine/memory-system.md` →
   * "Recall-outcome tagging".
   */
  recallBuffer?: MemoryRecallBuffer
  /**
   * Tags force-stamped onto every memory this tool *creates*, unioned with
   * (and never overriding) the model's own tags. Set by the workflow callee
   * executor to `['workflow:<workflowId>']` so a memory can be traced back to
   * the workflow that wrote it — the deterministic key behind recurring-run
   * memory continuity (prior-run visibility). Empty / absent → no injected
   * tags (chat behavior unchanged). Applies to create only, not update.
   * See `docs/architecture/features/workflow.md` → "assistant_call memory
   * continuity".
   */
  injectedTags?: string[]
}

/**
 * Create saveMemory, getMemory, and deleteMemory tools backed by a MemoryStore.
 *
 * `deleteMemory` sets `requiresConfirmation: true` — the tool executor
 * suspends the call until the channel-side ConfirmationResolver approves
 * or denies (same primitive as MCP write tools and scheduler 'ask'-policy
 * tools; see `packages/core/src/engine/tool-executor.ts:120-180`). The
 * tool takes an array of ids so the user sees every memory summary up
 * front and approves the whole batch with a single tap — no cascading
 * silent deletions, since the `describeConfirmation` hook resolves every
 * id to its summary before the prompt is shown.
 * See `docs/architecture/context-engine/memory-system.md` → "deleteMemory".
 */
export function createMemoryTools(
  store: MemoryStore,
  opts?: MemoryToolOptions,
): { saveMemory: Tool; getMemory: Tool; deleteMemory: Tool } {
  const saveMemory = buildTool({
    name: 'saveMemory',
    description:
      'Save or update a memory. Check the memory index first — if a related memory exists, update it instead of creating a duplicate. ' +
      'Do NOT save rules that belong on a structured tier: if you are capturing a policy about an existing scheduled_job (e.g. "no early mention", "send via Telegram only", "nag every 15 min"), call updateScheduledJob instead — the job row is the source of truth, and duplicating its policy as free-text memory keeps the topic primed in the per-turn index. ' +
      'Do NOT save negation memories ("don\'t mention X", "user doesn\'t want Y", "avoid Z") when the thing being negated already has a structured record — call `deleteMemory` on that record instead. Saving a "don\'t do X" memory re-primes X every retrieval (pink elephant) and is the exact behavior the user told you to stop. ' +
      'When updating an existing memory to add a clarification, exception, or refinement, pass ONLY the `detail` field in the update — leave `summary` out of the tool call entirely. The existing summary is preserved automatically. Change `summary` only when the core concept of the memory shifts (e.g. "dislikes eggs" → "dislikes all dairy"); a summary that keeps accreting caveats keeps re-priming the topic every turn.',
    inputSchema: z.object({
      id: z.string().optional().describe('Memory ID to update (full UUID returned by a prior save, or an 8-char prefix like `02eca923` from the memory index). Omit to create new.'),
      summary: z.string().optional().describe('One-line summary (shown in memory index). Required when creating a new memory; on update, omit to preserve the existing summary (only pass it when the core concept of the memory shifts).'),
      detail: z.string().max(16000, 'Memory detail too long — split into multiple memories or move long-form content to the knowledge base').optional().describe('Full detail (fetched on demand via getMemory)'),
      scope: z.enum(['user', 'team']).optional().describe('Visibility. Omit for the kind-aware default (personal → user, app → team). user = this user only; team = shared with every team member. Pass user explicitly only for per-member facts.'),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          'Tags — the single semantic axis for memories. ' +
            'Use `voice` ONLY for brand voice rules ' +
            'on a team-scoped distribution assistant (they render in a ' +
            'dedicated `## Voice Rules` block). Use `operational-state` ' +
            'for short-lived snapshots that should be pruned when stale. ' +
            'For user-self facts (name, role, location, birthday) call ' +
            '`updateSelfProfile` instead of saveMemory; for another person, ' +
            'company, or deal call `saveContact` / `saveCompany` / ' +
            '`saveDeal` (one record per distinct person — never collapse a ' +
            'team roster into one memory).',
        ),
      entityId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'When set, anchor this memory as a CRM note on a contact/company/deal entity. ' +
            'The memory is auto-tagged `note` and linked via entity_links ' +
            '(source_kind="memory", target_kind="entity", edge_type="mentioned"). ' +
            'Pass the entity id returned by getContact / getCompany / getDeal — those CRM ' +
            'rows expose the mirrored entity row id. Only valid on create (do not combine with `id`).',
        ),
      links: explicitLinksField,
    }),
    isConcurrencySafe: true,
    isReadOnly: false,

    async execute(input, context) {
      const opRejection = rejectOperationalStatePayload(input.summary, input.detail)
      if (opRejection) {
        return { data: opRejection, isError: true }
      }

      // CRM-note path is create-only. Combining `id` (update existing) with
      // `entityId` (anchor a new note) is ambiguous — D.7 supersession on the
      // entity row is the path for note updates, not saveMemory. Fail loudly
      // so the model retries with one or the other.
      if (input.id && input.entityId) {
        return {
          data: 'Cannot combine `id` with `entityId`. Use entityId to create a new note; use id alone to update an existing memory.',
          isError: true,
        }
      }

      if (input.id) {
        // Resolve full UUID from prefix if needed — mirrors getMemory's
        // fallback at lines 111-121. The memory index shows 8-char prefixes
        // like [id:abcd1234], so the model commonly passes that shape back.
        // Without this fallback the DB driver throws "invalid input syntax
        // for type uuid" which leaks to the tool result as a confusing error.
        let resolvedId = input.id
        if (input.id.length < 36) {
          const results = await store.search(viewerCtx(context), {
            query: '',
            limit: 1,
            idPrefix: input.id,
          })
          if (results[0]) resolvedId = results[0].id
        }
        // Pass the viewer context so the update is scoped to memories this
        // caller may read — a full UUID (length >= 36) skips the scoped search
        // above, so without this the write could supersede another user's or
        // workspace's memory by id (WS3 read/write-asymmetry fix). Ingested
        // third-party content reaches this tool, so the scope is load-bearing.

        // Update existing — only include defined fields.
        const updates: Record<string, unknown> = {}
        if (input.summary !== undefined) updates.summary = input.summary
        if (input.detail !== undefined) updates.detail = input.detail
        if (input.tags !== undefined) updates.tags = input.tags

        // Wrap in try/catch so malformed-UUID errors (when resolution above
        // didn't find a match and we're falling through with a non-UUID) are
        // translated into the softer "not found" result — the model can
        // retry sensibly instead of seeing a Postgres internal error.
        let updated
        try {
          updated = await store.update(resolvedId, updates, viewerCtx(context))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('invalid input syntax for type uuid')) {
            return { data: `Memory ${input.id} not found`, isError: true }
          }
          throw err
        }
        if (!updated) return { data: `Memory ${input.id} not found`, isError: true }
        opts?.onEvent?.({ type: 'memory_updated', memoryId: resolvedId })
        return { data: `Updated memory [${resolvedId}]: ${updated.summary}` }
      }

      // Create path requires `summary` — the schema marks it optional so updates
      // can omit it (description tells the model to leave it out on update), so
      // enforce the create-time requirement here.
      if (!input.summary) {
        return {
          data: 'saveMemory requires `summary` when creating a new memory. Pass an `id` to update an existing memory, or include a one-line summary to create a new one.',
          isError: true,
        }
      }

      // Free-plan memory cap: 20 memories max (see docs/architecture/platform/cost-and-pricing.md)
      if (opts?.userPlan === 'free') {
        const currentCount = await store.count(viewerCtx(context))
        if (currentCount >= 20) {
          return {
            data: 'Memory limit reached. Free accounts can save up to 20 memories. Upgrade to Pro for unlimited memories.',
            isError: true,
          }
        }
      }

      // Determine effective scope. When the model omits `scope`, fall back
      // to the kind-appropriate default: team-owned distribution assistants
      // ('app' kind) default to 'team' so voice/brand memory is visible to
      // every member. Personal assistants default to 'user' (status quo).
      // The model can still pass 'user' explicitly to opt back into personal
      // scope for a genuinely per-member fact.
      // PR 12 — memory-scope classifier centralises the decision tree.
      // Same semantics as the prior inline logic; formalised so the same
      // rules govern Pipeline B extraction + the chat tool + future
      // self-heal sweeps.
      const stampedSensitivityForScope: 'public' | 'internal' | 'confidential' =
        researchWriteFloor(context.sensitivity?.max, context.researchMode)
      const scopeDecision = decideMemoryScope({
        assistantKind: context.assistantKind ?? 'standard',
        workspaceId: context.workspaceId,
        sensitivity: stampedSensitivityForScope,
        emittedScope: input.scope,
      })
      const effectiveScope = scopeDecision.scope
      // Preserved error path: if the model emitted 'team' without a
      // workspace, decideMemoryScope force-routes to 'user' via the
      // `memory-scope-no-workspace-blocks-team` rule. Surface that as a
      // hard error (instead of silently saving as user) to match the
      // prior contract — the caller should know their input was rejected.
      if (
        input.scope === 'team' &&
        scopeDecision.ruleId === 'memory-scope-no-workspace-blocks-team'
      ) {
        return { data: 'Cannot save team memories — this assistant is not part of a team.', isError: true }
      }

      // Map model-facing scope to DB scope. Migration 110 renamed the
      // workspace-shared scope from 'team' → 'workspace' in `valid_scope`
      // CHECK (allowed: 'shared' | 'app' | 'workspace'). The model-facing
      // surface still uses 'user' / 'team' for readability; this is the
      // single point where we translate to the DB vocabulary.
      const dbScope: 'shared' | 'workspace' =
        effectiveScope === 'team' ? 'workspace' : 'shared'

      // Sensitivity stamp: inherit the max tier of any source the model
      // saw in this turn. Prevents confidential context from being
      // laundered into an 'internal' memory that a lower-clearance
      // assistant can then read. Absent accumulator = 'public' (baseline).
      // Research turns are the provenance exception: findings come from the
      // public web, so internal-tier brain-first orientation reads don't
      // raise the floor (confidential still does). See researchWriteFloor.
      const stampedSensitivity: Sensitivity = researchWriteFloor(
        context.sensitivity?.max,
        context.researchMode,
      )
      // Compartment stamp (MLS category axis): the high-water union of
      // compartments READ this turn (the laundering guard) + the assistant's
      // `default_compartments` auto-tag. Explicit per-write compartments arrive
      // with the tool-surface slice. See docs/plans/compartment-axis.md.
      const stampedCompartments = unionCompartments(
        context.compartmentAccumulator?.compartments,
        context.assistantDefaultCompartments,
      )

      // Voice tag is a team-scope-only concept — voice rules apply to
      // a team's distribution assistant, never to a personal assistant.
      // Reject `voice` tag when scope is user; this catches model
      // misuse without requiring the API layer to second-guess.
      if (input.tags?.includes('voice') && effectiveScope !== 'team') {
        return {
          data: "The 'voice' tag is only valid for team-scoped memories on a distribution assistant. Drop the tag or save with scope='team'.",
          isError: true,
        }
      }

      // Architectural-invariant guard (LOCKED #2 — staged-memory feedback
      // loop): confidential content must never land in workspace-shared
      // scope. The combination silently leaks per-user secrets into a
      // surface every workspace member can read; the asymmetry between
      // sensitivity (defensive ceiling) and scope (broadcast width) means
      // a single misroute is irreversible without a per-row scrub.
      //
      // This is the invariant we previously tried to enforce with a
      // synthetic eval bench — moving it to the write path makes the
      // rule deterministic and visible to the model on every save.
      if (stampedSensitivity === 'confidential' && effectiveScope === 'team') {
        return {
          data:
            'Refusing to save: sensitivity=\'confidential\' with scope=\'team\' would broadcast confidential content to every workspace member. ' +
            'Use scope=\'user\' for sensitive content, or lower the sensitivity if the content is genuinely safe to share team-wide. ' +
            'See docs/architecture/brain/corrections.md for the staged-memory feedback loop.',
          isError: true,
        }
      }

      // ── CRM-note prelude (WU-6.12) ────────────────────────────────
      // When `entityId` is set, this saveMemory call is creating a CRM
      // note. Resolve the entity, validate kind, and prepare the 'note'
      // tag before the memory write. The link itself is created after
      // the memory row so we have memory.id to anchor on. Spec:
      // `docs/architecture/brain/corrections.md` §"CRM notes via memory".
      let noteEntity:
        | { id: string; displayName: string; kind: string }
        | null = null
      let effectiveTags = input.tags
      if (input.entityId) {
        if (!opts?.entityStore || !opts?.entityLinksStore) {
          return {
            data: 'CRM-note anchoring is not available on this server (entity wiring missing). Save the memory without entityId, or use CRM tools to record the note context another way.',
            isError: true,
          }
        }
        if (!context.workspaceId) {
          return {
            data: 'CRM-note anchoring requires a workspace context. saveContact / saveCompany / saveDeal are only available to workspace-scoped sessions.',
            isError: true,
          }
        }
        const entity = await opts.entityStore.getById(viewerCtx(context), input.entityId)
        if (!entity) {
          return { data: `Entity ${input.entityId} not found.`, isError: true }
        }
        if (!CRM_NOTE_ENTITY_KINDS.has(entity.kind)) {
          return {
            data: `Cannot anchor a note on entity kind '${entity.kind}' — CRM notes anchor to person, company, or deal entities only (the kinds mirrored from CRM rows).`,
            isError: true,
          }
        }
        noteEntity = { id: entity.id, displayName: entity.displayName, kind: entity.kind }
        // Auto-tag 'note' per spec; preserve user-supplied tags + de-dupe.
        const baseTags = input.tags ?? []
        effectiveTags = baseTags.includes('note') ? baseTags : [...baseTags, 'note']
      }

      // Caller-injected tags (workflow tagging: `workflow:<id>`). Unioned with
      // the model's tags so a workflow-written memory is traceable to its
      // workflow without overriding anything the model chose. Create-only.
      if (opts?.injectedTags?.length) {
        effectiveTags = Array.from(new Set([...(effectiveTags ?? []), ...opts.injectedTags]))
      }

      // Create new. WU-2.2 stamps universal-column authorship from the
      // session context. `sourceEpisodeId` is left undefined — Pipeline B
      // (WS-3) is the writer that supplies an episode anchor; chat-driven
      // saveMemory has no episode.
      const memory = await store.create({
        assistantId: context.assistantId,
        userId: context.userId,
        scope: dbScope,
        tags: effectiveTags,
        summary: input.summary,
        detail: input.detail,
        source: 'model',
        sourceSessionId: context.sessionId,
        workspaceId: effectiveScope === 'team' ? context.workspaceId! : undefined,
        sensitivity: stampedSensitivity,
        compartments: stampedCompartments,
        createdByUserId: context.userId,
        createdByAssistantId: context.assistantId,
      })

      // memoryType analytics field — post-Phase-4 the model save no
      // longer carries a type. Use the first tag as a coarse stand-in
      // for analytics (or 'untyped' when no tag); the precise category
      // signal moves to tag-based reporting.
      opts?.onEvent?.({ type: 'memory_created', source: 'model', memoryType: effectiveTags?.[0] ?? 'untyped' })

      // ── CRM-note link write (WU-6.12) ─────────────────────────────
      // Edge writes are best-effort per WU-1.7 ("edges fire async /
      // fire-and-forget — never block the original save on edge insert
      // failure"). The memory is the source of truth; a missing link is
      // a brain-visibility regression, not a write failure. Log to
      // console.debug so an integration test or operator can still
      // diagnose drift.
      if (noteEntity && opts?.entityLinksStore && context.workspaceId) {
        try {
          await opts.entityLinksStore.create({
            sourceKind: 'memory',
            sourceId: memory.id,
            targetKind: 'entity',
            targetId: noteEntity.id,
            edgeType: 'mentioned',
            workspaceId: context.workspaceId,
            source: 'model',
            userId: context.userId,
            assistantId: context.assistantId,
            sensitivity: stampedSensitivity,
          })
        } catch (err) {
          console.debug('CRM-note link write failed:', err)
        }
        // Apply any additional explicit links (the model can reference
        // multiple entities in one memory — e.g. "Hinson and Anson are
        // both at SIDAN" mentions three entities; the primary anchor
        // becomes `entityId`, the others come through `links`).
        const linksSummary = await applyExplicitLinks({
          entityLinks: opts.entityLinksStore,
          workspaceId: context.workspaceId,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'memory',
          sourceId: memory.id,
          source: 'model',
          links: input.links,
        })
        return {
          data: `Saved note [${memory.id}] on ${noteEntity.displayName}: ${memory.summary}${formatLinksSummary(linksSummary)}`,
        }
      }

      // Non-CRM-note memory — still apply explicit links (memory →
      // entity[] edges). Lets the model encode the relationships the
      // memory describes without forcing an entityId anchor.
      const generalLinksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinksStore,
        workspaceId: context.workspaceId ?? '',
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'memory',
        sourceId: memory.id,
        source: 'model',
        links: context.workspaceId ? input.links : undefined,
      })
      // Return the FULL UUID so the model can round-trip it cleanly on a
      // later update. Returning just the 8-char prefix (as before) led to
      // the model fabricating the remaining 28 chars when it decided it
      // needed the full id — observed in prod 2026-04-23 with id prefixes
      // `02eca923` → hallucinated `02eca923-3b10-4822-8789-994119d88320`.
      return { data: `Saved memory [${memory.id}]: ${memory.summary}${formatLinksSummary(generalLinksSummary)}` }
    },
  })

  const getMemory = buildTool({
    name: 'getMemory',
    description:
      'Fetch ONE memory\'s full detail by its id. NOT a search tool: to find memories about a topic or keyword, call `search` instead (it returns memory rows ranked alongside every other brain primitive) and come back here with the id it gives you.',
    inputSchema: z.object({
      id: z.string().optional().describe('Memory ID or prefix to fetch (e.g. "5794afc9" from [id:5794afc9] in the memory index)'),
      // Hidden from the model-visible schema (MODEL_HIDDEN_PARAM_MARKER prefix)
      // but kept live in the zod schema so persisted histories / internal
      // callers that still pass `query` execute unchanged. The model kept
      // mapping "find memories about <topic>" onto this param instead of calling
      // `search`; removing the param from its view is the affordance fix. The
      // execute() path below still honors `query` (exact-phrase fallback).
      // See the MODEL_HIDDEN_PARAM_MARKER definition in ../engine/query-loop.ts.
      query: z.string().optional().describe(MODEL_HIDDEN_PARAM_MARKER + 'Exact-phrase fallback when you hold a near-verbatim fragment of the memory text but no id. Never for topic lookup: use the `search` tool for that.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,

    async execute(input, context) {
      if (input.id) {
        // Handle truncated IDs from the memory index (8-char prefix)
        const ctx = viewerCtx(context)
        let memory = await store.getById(ctx, input.id).catch(() => null)
        if (!memory && input.id.length < 36) {
          // Prefix search — the memory index shows [id:abcd1234] (8 chars)
          const results = await store.search(ctx, {
            query: '',
            limit: 1,
            idPrefix: input.id,
          })
          memory = results[0] ?? null
        }
        if (!memory) {
          opts?.onEvent?.({ type: 'memory_retrieved', source: 'id', resultCount: 0 })
          return { data: `Memory ${input.id} not found`, isError: true }
        }

        // Track recall (fire-and-forget) — aggregate counters on the
        // memory row, and a `tool_call`-kind row in the per-turn buffer.
        // The buffer is flushed by the chat route once the assistant
        // message id is known; see `recall-buffer.ts`.
        store.trackRecall(memory.id).catch((err) => console.debug('Memory recall tracking failed:', err))
        opts?.recallBuffer?.push(memory.id, 'tool_call')
        opts?.onEvent?.({ type: 'memory_retrieved', source: 'id', resultCount: 1 })

        return {
          data: {
            id: memory.id,
            summary: memory.summary,
            detail: memory.detail,
            tags: memory.tags,
          },
        }
      }

      if (input.query) {
        const queryHash = createHash('md5').update(input.query).digest('hex').slice(0, 8)

        // Search personal memories + team memories in parallel when team assistant
        const ctx = viewerCtx(context)
        const [personalResults, teamResults] = await Promise.all([
          store.search(ctx, {
            query: input.query,
            limit: 5,
          }),
          context.workspaceId
            ? store.searchTeam(ctx, {
                query: input.query,
                limit: 5,
              })
            : Promise.resolve([]),
        ])

        // Merge and dedupe by ID (personal results take priority)
        const seen = new Set<string>()
        const results = [...personalResults, ...teamResults].filter((m) => {
          if (seen.has(m.id)) return false
          seen.add(m.id)
          return true
        }).slice(0, 5)

        // Track recalls for all results — aggregate counters + per-turn
        // buffer rows. See note above for the buffer's role.
        for (const m of results) {
          store.trackRecall(m.id, queryHash).catch((err) => console.debug('Memory recall tracking failed:', err))
        }
        if (opts?.recallBuffer) {
          opts.recallBuffer.pushMany(results.map((m) => m.id), 'tool_call')
        }

        opts?.onEvent?.({ type: 'memory_retrieved', source: 'search', resultCount: results.length, query: input.query })

        if (results.length === 0) return { data: 'No matching memories found.' }

        return {
          data: results.map((m) => ({
            id: m.id,
            summary: m.summary,
            detail: m.detail,
            tags: m.tags,
          })),
        }
      }

      return { data: 'Provide either an id or a query.', isError: true }
    },
  })

  /**
   * Resolve a single id (prefix or full UUID) to a memory record. Same
   * fallback logic as getMemory + saveMemory — the memory index shows
   * 8-char prefixes and the model commonly passes that shape back.
   */
  async function resolveMemoryId(
    id: string,
    ctx: AccessContext,
  ): Promise<import('./types.js').MemoryRecord | null> {
    let memory = await store.getById(ctx, id).catch(() => null)
    if (!memory && id.length < 36) {
      const results = await store.search(ctx, {
        query: '',
        limit: 1,
        idPrefix: id,
      })
      memory = results[0] ?? null
    }
    return memory
  }

  const deleteMemory = buildTool({
    name: 'deleteMemory',
    description:
      'Permanently remove one or more memories. User approval is required before the deletions run; the system surfaces a single confirmation UI listing every memory summary, and the tool blocks until the user approves or denies the whole batch. ' +
      'Use this — NOT `saveMemory` — when the user asks you to forget, stop tracking, or no longer remember something you previously saved. Saving a "do not mention X" rule instead keeps X in the memory index, re-priming the topic every turn (pink-elephant effect); deletion is the correct response to removal intent. ' +
      'For recurring policy that lives on a scheduled_job (e.g. "stop reminding me daily"), call `updateScheduledJob` (disable or silenceUntilFire) first and then delete any now-redundant memory. ' +
      'Pass every id that should be removed in one call via `ids` — even for a single memory, use `ids: ["<uuid>"]`. Bundling into one call keeps the approval flow to a single tap instead of one prompt per memory.',
    inputSchema: z.object({
      ids: z.array(z.string()).min(1).describe('Memory IDs to delete — full UUIDs from a prior save/getMemory, or 8-char prefixes shown in the memory index (e.g. `02eca923`). Pass all ids in one call to batch the user confirmation.'),
    }),
    requiresConfirmation: true,
    isConcurrencySafe: false,
    isReadOnly: false,
    allowPersistentApproval: false,

    async describeConfirmation(input, context) {
      const ids = (input as { ids?: unknown }).ids
      if (!Array.isArray(ids) || ids.length === 0) return null
      const strIds = ids.filter((v): v is string => typeof v === 'string')
      if (strIds.length === 0) return null

      const resolved = await Promise.all(
        strIds.map((id) => resolveMemoryId(id, viewerCtx(context))),
      )
      return resolved.map((memory, i) =>
        memory ? `• ${memory.summary}` : `• (not found: ${strIds[i]})`,
      )
    },

    async execute(input, context) {
      // The confirmation gate already passed (tool-executor.ts:120-180).
      // Resolve each id, skip not-found entries, and delete the rest.
      const resolved = await Promise.all(
        input.ids.map((id) => resolveMemoryId(id, viewerCtx(context))),
      )

      const deleted: string[] = []
      const missing: string[] = []

      for (let i = 0; i < resolved.length; i++) {
        const memory = resolved[i]
        const originalId = input.ids[i]
        if (!memory) {
          missing.push(originalId)
          continue
        }
        try {
          await store.deleteMemory(memory.id)
          deleted.push(memory.summary)
          opts?.onEvent?.({ type: 'memory_deleted', memoryId: memory.id })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('invalid input syntax for type uuid')) {
            missing.push(originalId)
            continue
          }
          throw err
        }
      }

      if (deleted.length === 0) {
        return { data: `No memories deleted. Not found: ${missing.join(', ')}`, isError: true }
      }

      const parts = [`Deleted ${deleted.length} memor${deleted.length === 1 ? 'y' : 'ies'}: ${deleted.join('; ')}`]
      if (missing.length > 0) parts.push(`Not found: ${missing.join(', ')}`)
      return { data: parts.join('. ') }
    },
  })

  return { saveMemory, getMemory, deleteMemory }
}
