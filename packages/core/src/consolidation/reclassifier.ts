/**
 * Self-healing reclassifier (Q5 / Q8 of the brain-ingestion-classification
 * design thread). Examines existing memories and decides, per memory,
 * whether they would have been better expressed as a drop, task, edge,
 * or entity attribute — and auto-applies the safe cases (drop / task /
 * edge) while surfacing the risky attribute case as a candidate the
 * user accepts via `acceptBrainCandidate`.
 *
 * Design constraints (from Q5):
 *   - Additive-on-target: memory → entity is a link, not an in-place
 *     mutation of `entities.attributes` (which is reserved for the
 *     existing `promoteMemoryToEntity` path that requires the original
 *     author's authorization).
 *   - Four guardrails: per-workspace daily cap of 20, skip <24h-old
 *     memories, skip high-blast-radius (>3 outbound entity_links),
 *     skip high-sensitivity (`confidential` / `restricted`).
 *   - Auto-apply drop / task / edge with audit + undo via
 *     `brain_candidates` (mig 198).
 *   - Surface attribute candidates as pending rows; user accepts via
 *     chat tool that delegates to `promoteMemoryToEntity` (Q8).
 *
 * v1 wiring path: called from the `healMemories` chat tool — user-
 * initiated, scope-limited, rate-limited. The cron-driven REM-attached
 * sweep is a follow-up; the chat-tool path covers the immediate user
 * value (proactive heal on demand).
 *
 * [COMP:brain/reclassifier]
 */

import type {
  BrainCandidateAction,
  BrainCandidateStore,
} from '../brain/candidates-types.js'
import type {
  EntityLinkCreateParams,
  EntityLinksStore,
  EntityStore,
  EntityRecord,
} from '../entities/types.js'
import type { MemoryRecord, MemoryStore } from '../memory/types.js'
import type { LLMProvider } from '../providers/types.js'
import type { Sensitivity } from '../security/sensitivity.js'
import type { TaskStore } from '../tasks/types.js'
import { collectStream } from '../providers/accumulator.js'
import { z } from 'zod'

// ── Tunables (match Q5 lock) ─────────────────────────────────────────

/** Per-workspace cap on reclassifications per invocation. */
export const RECLASSIFICATION_DAILY_CAP = 20

/** Skip memories younger than this — let the human still in active
 *  context confirm/edit them first. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000

/** Skip memories tagged at or above this sensitivity — Q5 guardrail.
 *  `confidential` is the top tier in the current 3-value Sensitivity
 *  enum; if a future migration widens to a `restricted` tier add it
 *  here. */
const SKIPPED_SENSITIVITIES: ReadonlySet<Sensitivity> = new Set<Sensitivity>([
  'confidential',
])

/** Skip memories with more outbound entity_links than this — high
 *  blast radius, defer to the user. */
const MAX_BLAST_RADIUS = 3

/** Cap on existing entities included in the LLM prompt context. */
const ENTITY_CONTEXT_CAP = 200

// ── Decision schema (LLM output) ─────────────────────────────────────

/** One proposed new primitive an `extract` decision wants spun out of a
 *  memory that bundles several entities/facts. Never auto-applied — each
 *  becomes a pending `brain_candidates` row for the user to accept. */
const extractTargetSchema = z.object({
  /** Candidate primitive bucket — e.g. `crm_contact`, `entity`. Carried
   *  through to `brain_candidates.target_kind`. */
  kind: z.string(),
  display_name: z.string(),
  summary: z.string().optional(),
  /** When `kind` is the generic `entity`, the entity sub-kind (company /
   *  project / …) the user would create. */
  entity_kind: z.string().optional(),
})

const decisionSchema = z.object({
  memory_id: z.string(),
  decision: z.enum(['drop', 'task', 'edge', 'attribute', 'extract', 'keep']),
  target_entity_display_name: z.string().optional(),
  suggested_task_text: z.string().optional(),
  suggested_attribute_key: z.string().optional(),
  suggested_attribute_value: z.unknown().optional(),
  /** Populated when `decision === 'extract'`: one entry per primitive the
   *  memory should be split into. Empty/absent → counted as an unresolved
   *  target (the LLM flagged extract but named nothing). */
  extract_targets: z.array(extractTargetSchema).optional(),
  reason: z.string().min(1).max(300),
  confidence: z.number().min(0).max(1).optional(),
})

const decisionsSchema = z.object({
  decisions: z.array(decisionSchema).max(RECLASSIFICATION_DAILY_CAP * 2),
})

export type ReclassificationDecision = z.infer<typeof decisionSchema>

// ── Inputs / outputs ─────────────────────────────────────────────────

export interface MemoryForReclassification {
  id: string
  summary: string
  detail: string | null
  tags: string[]
  scope: string
  sensitivity: Sensitivity
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string
  createdByAssistantId: string | null
  createdAt: Date
}

export interface ReclassificationDeps {
  /** Memory candidates the worker should consider. The caller is
   *  responsible for pre-filtering (age, sensitivity, blast-radius). */
  memories: readonly MemoryForReclassification[]
  /** Existing entities in the workspace — provided to the LLM as
   *  context so it can match a memory to an existing entity for an
   *  edge or attribute candidate. Capped server-side at
   *  `ENTITY_CONTEXT_CAP` rows. */
  entities: readonly Pick<EntityRecord, 'id' | 'displayName' | 'kind'>[]
  workspaceId: string
  actorUserId: string
  actorAssistantId: string | null
  /** Stores for auto-apply. */
  memoryStore: MemoryStore
  taskStore: TaskStore
  entityLinks: EntityLinksStore
  /** Audit + queue. */
  candidates: BrainCandidateStore
  /** LLM. */
  provider: LLMProvider
  model: string
}

export interface ReclassificationResult {
  /** Decisions the LLM emitted (after schema validation). */
  decisions: ReclassificationDecision[]
  /** Auto-applied actions by `to_kind`. */
  applied: { drop: number; task: number; edge: number }
  /** Attribute candidates enqueued (pending user accept). */
  enqueuedAttribute: number
  /** Extract candidates enqueued (pending user accept) — one row per
   *  `extract_targets` entry across all `extract` decisions. */
  enqueuedExtract: number
  /** Memories the LLM chose to keep unchanged. */
  kept: number
  /** Decisions that referenced an entity that couldn't be resolved, or an
   *  `extract` decision that named no targets. */
  unresolvedTargets: number
  /** Memories the LLM silently omitted from its decision list. Surfaced as
   *  its own bucket so the chat-side report doesn't paraphrase "kept by
   *  silence" as "the brain is already optimal". */
  noOpinion: number
}

// ── Filtering (caller-side helper; exposed for tests + the chat tool) ─

export function filterMemoriesForReclassification(
  memories: readonly MemoryForReclassification[],
  blastRadiusByMemoryId: ReadonlyMap<string, number>,
  now: Date = new Date(),
  /** In-flight Phase 6+ opt-in. When true, the <24h age cutoff is bypassed
   * (used for user-initiated heals where freshness is wanted). Default false. */
  opts?: { includeRecent?: boolean },
): MemoryForReclassification[] {
  const cutoff = now.getTime() - MIN_AGE_MS
  return memories
    .filter((m) => opts?.includeRecent === true || m.createdAt.getTime() <= cutoff)
    .filter((m) => !SKIPPED_SENSITIVITIES.has(m.sensitivity))
    .filter((m) => (blastRadiusByMemoryId.get(m.id) ?? 0) <= MAX_BLAST_RADIUS)
    .slice(0, RECLASSIFICATION_DAILY_CAP)
}

// ── Orchestration ────────────────────────────────────────────────────

export async function runReclassification(
  deps: ReclassificationDeps,
): Promise<ReclassificationResult> {
  if (deps.memories.length === 0) {
    return emptyResult()
  }

  const entityList = deps.entities.slice(0, ENTITY_CONTEXT_CAP)
  const prompt = buildReclassificationPrompt(deps.memories, entityList)

  let raw: string
  try {
    raw = await callLLM(deps.provider, deps.model, prompt)
  } catch (err) {
    console.warn(
      `[reclassifier] LLM call failed for workspace ${deps.workspaceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return emptyResult()
  }

  const parsed = parseDecisions(raw)
  if (!parsed) return emptyResult()

  const entityByName = new Map(
    entityList.map((e) => [e.displayName.toLowerCase(), e]),
  )
  const memoryById = new Map(deps.memories.map((m) => [m.id, m]))

  const result: ReclassificationResult = {
    decisions: parsed,
    applied: { drop: 0, task: 0, edge: 0 },
    enqueuedAttribute: 0,
    enqueuedExtract: 0,
    kept: 0,
    unresolvedTargets: 0,
    noOpinion: 0,
  }

  // Memories the LLM silently dropped from its decision list — "kept by
  // silence". Counted up-front from the gap between what we sent and what
  // came back, so the chat report can distinguish it from an explicit keep.
  const decidedIds = new Set(parsed.map((d) => d.memory_id))
  result.noOpinion = deps.memories.filter((m) => !decidedIds.has(m.id)).length

  for (const decision of parsed) {
    const memory = memoryById.get(decision.memory_id)
    if (!memory) continue

    try {
      switch (decision.decision) {
        case 'keep':
          result.kept += 1
          break

        case 'drop':
          await applyDrop(deps, memory, decision)
          result.applied.drop += 1
          break

        case 'task': {
          const ok = await applyTask(deps, memory, decision)
          if (ok) result.applied.task += 1
          else result.unresolvedTargets += 1
          break
        }

        case 'edge': {
          const target = decision.target_entity_display_name
            ? entityByName.get(decision.target_entity_display_name.toLowerCase())
            : undefined
          if (!target) {
            result.unresolvedTargets += 1
            break
          }
          await applyEdge(deps, memory, decision, target)
          result.applied.edge += 1
          break
        }

        case 'attribute': {
          const target = decision.target_entity_display_name
            ? entityByName.get(decision.target_entity_display_name.toLowerCase())
            : undefined
          if (!target) {
            result.unresolvedTargets += 1
            break
          }
          await enqueueAttribute(deps, memory, decision, target)
          result.enqueuedAttribute += 1
          break
        }

        case 'extract': {
          const targets = decision.extract_targets ?? []
          if (targets.length === 0) {
            // extract flagged but nothing named — surface as unresolved
            // rather than silently swallowing the decision.
            result.unresolvedTargets += 1
            break
          }
          const enqueued = await enqueueExtractTargets(deps, memory, decision, targets)
          result.enqueuedExtract += enqueued
          break
        }
      }
    } catch (err) {
      console.warn(
        `[reclassifier] action ${decision.decision} failed for memory ${memory.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  return result
}

// ── Action handlers ──────────────────────────────────────────────────

async function applyDrop(
  deps: ReclassificationDeps,
  memory: MemoryForReclassification,
  decision: ReclassificationDecision,
): Promise<void> {
  // Capture pre-state in candidate so undo can recreate.
  const snapshot = snapshotMemory(memory)
  await deps.memoryStore.deleteMemory(memory.id)
  await deps.candidates.enqueue({
    workspaceId: deps.workspaceId,
    memoryId: memory.id,
    suggestedAction: 'drop',
    suggestedValue: snapshot,
    reason: decision.reason,
    confidence: decision.confidence ?? null,
    autoApplied: true,
    createdByUserId: deps.actorUserId,
    createdByAssistantId: deps.actorAssistantId,
  })
}

async function applyTask(
  deps: ReclassificationDeps,
  memory: MemoryForReclassification,
  decision: ReclassificationDecision,
): Promise<boolean> {
  const title = decision.suggested_task_text?.trim()
  if (!title) return false

  const task = await deps.taskStore.create({
    userId: deps.actorUserId,
    workspaceId: deps.workspaceId,
    title,
  })
  const snapshot = snapshotMemory(memory)
  await deps.memoryStore.deleteMemory(memory.id)
  await deps.candidates.enqueue({
    workspaceId: deps.workspaceId,
    memoryId: memory.id,
    suggestedAction: 'task',
    targetKind: 'task',
    targetId: task.id,
    suggestedValue: snapshot,
    reason: decision.reason,
    confidence: decision.confidence ?? null,
    autoApplied: true,
    createdByUserId: deps.actorUserId,
    createdByAssistantId: deps.actorAssistantId,
  })
  return true
}

async function applyEdge(
  deps: ReclassificationDeps,
  memory: MemoryForReclassification,
  decision: ReclassificationDecision,
  target: { id: string },
): Promise<void> {
  const params: EntityLinkCreateParams = {
    sourceKind: 'memory',
    sourceId: memory.id,
    targetKind: 'entity',
    targetId: target.id,
    edgeType: 'mentioned',
    workspaceId: deps.workspaceId,
    source: 'extracted',
    userId: memory.userId,
    assistantId: memory.assistantId,
    sensitivity: memory.sensitivity,
  }
  const link = await deps.entityLinks.create(params)
  await deps.candidates.enqueue({
    workspaceId: deps.workspaceId,
    memoryId: memory.id,
    suggestedAction: 'edge',
    targetKind: 'entity_link',
    targetId: link.id,
    reason: decision.reason,
    confidence: decision.confidence ?? null,
    autoApplied: true,
    createdByUserId: deps.actorUserId,
    createdByAssistantId: deps.actorAssistantId,
  })
}

async function enqueueAttribute(
  deps: ReclassificationDeps,
  memory: MemoryForReclassification,
  decision: ReclassificationDecision,
  target: { id: string },
): Promise<void> {
  await deps.candidates.enqueue({
    workspaceId: deps.workspaceId,
    memoryId: memory.id,
    suggestedAction: 'attribute',
    targetKind: 'entity',
    targetId: target.id,
    suggestedKey: decision.suggested_attribute_key ?? null,
    suggestedValue: decision.suggested_attribute_value,
    reason: decision.reason,
    confidence: decision.confidence ?? null,
    autoApplied: false,
    createdByUserId: deps.actorUserId,
    createdByAssistantId: deps.actorAssistantId,
  })
}

/**
 * Enqueue one pending `extract` candidate per proposed target — never
 * auto-applied. `targetId` stays null (the primitive doesn't exist yet);
 * `targetKind` carries the proposed bucket and `suggestedValue` carries the
 * proposed display name + summary so the accept path can mint the row.
 * Returns the number of candidates enqueued.
 */
async function enqueueExtractTargets(
  deps: ReclassificationDeps,
  memory: MemoryForReclassification,
  decision: ReclassificationDecision,
  targets: NonNullable<ReclassificationDecision['extract_targets']>,
): Promise<number> {
  let enqueued = 0
  for (const target of targets) {
    await deps.candidates.enqueue({
      workspaceId: deps.workspaceId,
      memoryId: memory.id,
      suggestedAction: 'extract',
      targetKind: target.kind,
      targetId: null,
      suggestedValue: {
        kind: target.kind,
        displayName: target.display_name,
        ...(target.summary !== undefined ? { summary: target.summary } : {}),
        ...(target.entity_kind !== undefined ? { entityKind: target.entity_kind } : {}),
      },
      reason: decision.reason,
      confidence: decision.confidence ?? null,
      autoApplied: false,
      createdByUserId: deps.actorUserId,
      createdByAssistantId: deps.actorAssistantId,
    })
    enqueued += 1
  }
  return enqueued
}

// ── Helpers ──────────────────────────────────────────────────────────

function snapshotMemory(memory: MemoryForReclassification): Record<string, unknown> {
  return {
    summary: memory.summary,
    detail: memory.detail,
    tags: memory.tags,
    scope: memory.scope,
    sensitivity: memory.sensitivity,
    workspaceId: memory.workspaceId,
    userId: memory.userId,
    assistantId: memory.assistantId,
    createdByUserId: memory.createdByUserId,
    createdByAssistantId: memory.createdByAssistantId,
  }
}

function emptyResult(): ReclassificationResult {
  return {
    decisions: [],
    applied: { drop: 0, task: 0, edge: 0 },
    enqueuedAttribute: 0,
    enqueuedExtract: 0,
    kept: 0,
    unresolvedTargets: 0,
    noOpinion: 0,
  }
}

async function callLLM(
  provider: LLMProvider,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await collectStream(
    provider.stream({
      model,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt:
        'You are the brain reclassifier. For each memory in the input, decide whether it would have been better expressed as a drop / task / edge / attribute / extract, or kept as a memory. Output ONE JSON object and nothing else. No markdown fences. No commentary.',
      maxTokens: 4_000,
    }),
  )
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
}

function parseDecisions(raw: string): ReclassificationDecision[] | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0])
    const result = decisionsSchema.safeParse(obj)
    if (!result.success) {
      console.warn(`[reclassifier] schema mismatch: ${result.error.issues[0]?.message ?? 'unknown'}`)
      return null
    }
    return result.data.decisions
  } catch (err) {
    console.warn(
      `[reclassifier] JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

// ── Prompt builder ───────────────────────────────────────────────────

export function buildReclassificationPrompt(
  memories: readonly MemoryForReclassification[],
  entities: readonly Pick<EntityRecord, 'id' | 'displayName' | 'kind'>[],
): string {
  const entityList = entities.length === 0
    ? '(no existing entities in this workspace)'
    : entities
        .map((e) => `- ${e.displayName} [${e.kind}]`)
        .join('\n')

  const memoryList = memories
    .map((m) => {
      const detail = m.detail ? `\n  detail: ${m.detail}` : ''
      const tags = m.tags.length > 0 ? `\n  tags: ${m.tags.join(', ')}` : ''
      return `- id: ${m.id}\n  summary: ${m.summary}${detail}${tags}`
    })
    .join('\n')

  return `You are auditing a brain's memory pile. For each memory below, decide whether it would have been better expressed as another primitive — and act on the decision.

Decision options (in precedence order — pick the first that fits):
  - "task": the memory describes an action the user (or someone) needs to do. Suggest the imperative text in "suggested_task_text".
  - "edge": the memory is about an existing entity (see "Existing entities" below). Identify the entity by display_name in "target_entity_display_name". This will link the memory to the entity without altering either.
  - "attribute": the memory IS a structured attribute of an existing entity (e.g. "Alice is CEO" → entity=Alice, key="role", value="CEO"). Set "target_entity_display_name", "suggested_attribute_key", "suggested_attribute_value". This will be queued as a candidate for the user to accept.
  - "extract": the memory bundles one or more NEW entities/people that don't exist yet and deserve their own primitive (e.g. "Harry Ho founded AOGB and studied at CUHK" → a contact for Harry Ho plus company entities for AOGB and CUHK). List each in "extract_targets" with its "kind" (crm_contact | entity), "display_name", optional "summary", and "entity_kind" (company / project / …) when kind is "entity". Each target is queued as a candidate for the user to accept — never auto-applied.
  - "drop": the memory has no durable value (operational state, ack-only, status-update, relative-time marker, duplicate). It will be soft-deleted.
  - "keep": the memory is correctly shaped as a memory and shouldn't be moved.

Existing entities in this workspace (use display_name verbatim when identifying targets):
${entityList}

Memories to audit:
${memoryList}

Output JSON only, matching this exact shape:
{
  "decisions": [
    {
      "memory_id": "<id from input>",
      "decision": "task" | "edge" | "attribute" | "extract" | "drop" | "keep",
      "target_entity_display_name": "<entity display_name when decision is edge or attribute>",
      "suggested_task_text": "<imperative when decision is task>",
      "suggested_attribute_key": "<JSONB key when decision is attribute>",
      "suggested_attribute_value": <JSON value when decision is attribute>,
      "extract_targets": [{ "kind": "crm_contact" | "entity", "display_name": "<name>", "summary": "<optional one-liner>", "entity_kind": "<company|project|… when kind is entity>" }],
      "reason": "<one sentence — why this decision>",
      "confidence": <0..1 self-graded>
    }
  ]
}

Rules:
- If you can't articulate why a memory is wrong-shaped, decide "keep".
- "attribute" requires both a key and a value. Don't propose "attribute" with no structured fact extracted.
- "edge" / "attribute" require an existing entity from the list above. Never invent a new entity.
- "extract" is for NEW entities not in the list above — name each one in "extract_targets". Don't use "extract" for entities that already exist (use "edge" instead).
- One decision per memory_id. Omit memories you have no opinion on (treat as keep).`
}
