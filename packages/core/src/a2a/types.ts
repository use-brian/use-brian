/**
 * A2A wire-format types for `consultAssistant`.
 *
 * Pragmatic adoption of Google A2A's noun model (Task / A2AMessage / Part /
 * Artifact) without the JSON-RPC envelope. In-process today; a thin binding
 * layer maps these types onto A2A's spec shape when external endpoints land.
 *
 * Naming note: this module's `Capability` is what an assistant exposes to
 * external callers (one declared action with typed I/O and a constrained tool
 * surface). It is NOT the same concept as `SkillMeta` in
 * `packages/core/src/skills/`, which models internal markdown prompt bundles
 * the assistant loads to guide its own behavior. At the wire binding,
 * `Capability` serializes into A2A spec's `AgentCard.skills[]` field.
 *
 * See docs/architecture/integrations/a2a.md for the full spec.
 *
 * [COMP:a2a/types]
 */

import type { z } from 'zod'
import type { ResearchDepthConfig } from '../engine/research-depth.js'
import type { ErrorCode } from './limits.js'

// ── Identity ────────────────────────────────────────────────────────────

/**
 * Top-level entry points that can initiate a consult chain. Includes
 * `'a2a-external'` from day one so the deferred external-endpoint work is a
 * binding implementation, not an enum migration.
 */
export type ChannelType =
  | 'web'
  | 'telegram'
  | 'slack'
  | 'cron'
  | 'workflow'
  | 'a2a-external'

/**
 * Carried in every `ConsultRequest` so the destination can resolve sharing
 * rules and authorization.
 */
export type CallerIdentity = {
  workspaceId: string
  assistantId: string
  /** `null` for cron / workflow / system-initiated callers. */
  userId: string | null
  channelType: ChannelType
}

// ── Parts ───────────────────────────────────────────────────────────────

/**
 * Discriminated union over content kinds. Building block of `A2AMessage` and
 * `Artifact`. Mirrors A2A spec's Part discriminator exactly.
 */
export type Part =
  | { kind: 'text'; text: string }
  | {
      kind: 'file'
      mimeType: string
      ref:
        | { type: 'inline'; bytes: string }
        | { type: 'url'; uri: string }
    }
  | { kind: 'data'; data: Record<string, unknown> }

// ── Messages and Artifacts ──────────────────────────────────────────────
// Spec rule: messages = conversation, artifacts = result. Conflating them
// is one of the most common A2A implementation bugs; we keep them separate.

export type A2AMessage = {
  messageId: string
  role: 'user' | 'agent'
  parts: Part[]
  contextId?: string
  taskId?: string
}

export type Artifact = {
  artifactId: string
  /** Human-readable label, e.g. "threads-post-id". */
  name?: string
  parts: Part[]
}

// ── Tasks ───────────────────────────────────────────────────────────────

export type TaskState =
  | 'submitted'
  | 'working'
  /** Destination is asking caller for more (ask-mode share, owner approval). */
  | 'input_required'
  /** External caller needs auth (deferred — external endpoints only). */
  | 'auth_required'
  | 'completed'
  | 'failed'
  | 'canceled'

export type TaskStatus = {
  state: TaskState
  /**
   * Optional. For `input_required`: question for the caller. For `failed`:
   * error explanation. For terminal success states: typically omitted.
   */
  message?: A2AMessage
  /** ISO 8601. */
  timestamp: string
}

export type Task = {
  taskId: string
  contextId: string
  status: TaskStatus
  artifacts: Artifact[]
  /**
   * Populated only in free mode for multi-turn conversation context.
   * Restricted-mode capability invocations leave this undefined.
   */
  history?: A2AMessage[]
}

// ── Modes (destination-side access policy) ──────────────────────────────

/**
 * An owner-curated bundle of (exposed_tools, freshness, data scopes, policy)
 * that a destination assistant offers to inbound callers. A connection can
 * bind to exactly one mode (decision #4); absence of binding = full access
 * (free, decision #3). When a `ConsultRequest` lands on the destination, the
 * destination resolves the caller's connection's mode and applies its filter
 * before running the query loop.
 *
 * Modes are NOT on the wire — they're destination config. The wire format
 * (`ConsultRequest`) carries caller identity; the destination looks up the
 * mode-bound connection and applies the mode locally. See
 * `docs/architecture/integrations/a2a.md` and
 * `docs/architecture/integrations/a2a.md`.
 */
export type AssistantMode = {
  id: string
  assistantId: string
  name: string
  description: string | null
  /** Tool names the destination's query loop is allowed to use under this mode. */
  exposedTools: string[]
  freshness: 'live' | 'snapshot'
  /**
   * If true, every consult on a connection bound to this mode enters
   * `Task.status.state='input_required'` and waits for owner approval.
   * Replaces today's per-category `share_mode='ask'`.
   */
  requireApproval: boolean
  allowOnwardConsults: boolean
  /** Knowledge sensitivity ceiling. NULL = unrestricted. */
  knowledgeMaxSensitivity: string | null
  /** Memory categories. NULL = unrestricted, [] = none, list = specific. */
  memoryCategories: string[] | null
  createdAt: Date
  updatedAt: Date
}

// ── Capability surface ──────────────────────────────────────────────────

/**
 * One declared external action a specialist assistant can perform.
 *
 * `id` format: `<domain>.<entity>.<action>` namespaced dot-path, lowerCamelCase
 * per segment. Examples: `distribution.threads.publishPost`,
 * `crm.contact.create`.
 *
 * `exposedTools` is the **single source of truth for leafness**: a capability
 * is a leaf iff `'consultAssistant' ∉ exposedTools`. The destination's query
 * loop receives only these tool names when running this capability.
 */
export type Capability = {
  id: string
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  outputSchema?: z.ZodType<unknown>
  exposedTools: string[]
}

/**
 * Directory entry for a specialist assistant. The actual registry that holds
 * cards is §3's responsibility — this type defines the row shape.
 */
export type SpecialistCard = {
  assistantId: string
  workspaceId: string
  name: string
  description: string
  capabilities: Capability[]
  /** Whether this specialist accepts free-mode (no `capabilityId`) consultation. */
  acceptsFreeChat: boolean
}

// ── Loop-prevention envelope ────────────────────────────────────────────

/**
 * Required on every `ConsultRequest`. Three layered defenses:
 *
 * - `path`: visited set (assistantIds, ordered first-caller → most recent).
 *   Cycle detected if `target.assistantId ∈ path`.
 * - `depth`: hard cap (mode-specific via `CONSULT_LIMITS`). Denormalized;
 *   `depth === path.length` always.
 * - `budget`: remaining consults allowed in this top-level chain. Initialized
 *   from `INITIAL_BUDGET[entryPoint]` at top level; decremented per consult.
 *
 * See docs/architecture/integrations/a2a.md → "Loop prevention".
 */
export type ConsultChain = {
  path: string[]
  depth: number
  budget: number
}

// ── The primitive ───────────────────────────────────────────────────────

/**
 * Mode discriminator: `target.capabilityId` present = restricted mode (typed
 * input, fixed tool surface, structured artifact result). Absent = free mode
 * (free-text conversation, full tool surface, conversational reply).
 */
export type ConsultRequest = {
  target: {
    workspaceId: string
    assistantId: string
    capabilityId?: string
  }
  message: A2AMessage
  /** Continues an existing context if set; starts a new context if absent. */
  contextId?: string
  /**
   * Optional per-consult tool allow-list. When set, the destination's query
   * loop is restricted to *only* these tool names — the final filter applied
   * after mode resolution. Set by workflow `assistant_call` steps that pin a
   * `tools` restriction. Absent = the destination's normal tool surface.
   */
  allowedTools?: string[]
  /**
   * Optional research-depth override for the callee's agentic loop. Set by a
   * workflow `assistant_call` step (or a scheduled job, via its one-step
   * workflow) carrying a `depth` field. Absent = the callee's default budget.
   * See `packages/core/src/engine/research-depth.ts`.
   */
  depth?: ResearchDepthConfig
  /**
   * Optional model alias for the callee's query loop — set by a workflow's
   * top-level `modelAlias` so every `assistant_call` step uses the workflow's
   * configured tier. Resolved against `MODEL_MAP` at call time; absent =
   * historical default (Pro tier).
   */
  modelAlias?: 'standard' | 'pro' | 'max'
  /**
   * Optional user-channel delivery target. Set by workflow `assistant_call`
   * steps that carry a `deliver` field (scheduled-job reminders). When
   * present, the callee executor surfaces `ask`-policy tool confirmations to
   * this channel instead of stripping them. Absent = ordinary A2A — the
   * inter-assistant approval was already granted, so confirmations are
   * stripped. See docs/architecture/engine/scheduled-jobs.md →
   * "Deferred confirmations".
   */
  deliver?: { channelType: 'web' | 'telegram' | 'slack' | 'whatsapp'; channelId: string }
  /**
   * Optional page anchor for a workflow `assistant_call` step. Always a
   * concrete `saved_views` id by the time it is on the wire — the workflow
   * executor resolves `{ create }` / `{ fromStep }` variants to a flat uuid
   * before the consult. The callee executor gates access (RLS + workspace +
   * clearance), injects the doc tools, and runs the callee with
   * `ToolContext.docViewId` set — a doc-anchored session, exactly like an
   * interactive doc chat turn. See
   * docs/architecture/features/workflow.md → "assistant_call page anchor".
   */
  pageAnchorId?: string
  caller: CallerIdentity
  chain: ConsultChain
}

export type ConsultResponse = {
  task: Task
}

// ── Errors ──────────────────────────────────────────────────────────────

/**
 * JSON-RPC-shaped error. The optional `reason` field carries a stable string
 * tag for chain-rejection cases (`cycle_detected` / `depth_exceeded` /
 * `budget_exhausted`) so the caller's LLM can adapt rather than crash.
 */
export type ConsultError = {
  code: ErrorCode
  message: string
  reason?:
    | 'cycle_detected'
    | 'depth_exceeded'
    | 'budget_exhausted'
    | 'capability_not_found'
    | 'sharing_blocked'
    | 'input_invalid'
  data?: unknown
}

// ── Transport ───────────────────────────────────────────────────────────

/**
 * In-process today; JSON-RPC/HTTP binding later. Same interface either way —
 * §3's call sites do not change when external endpoints land.
 *
 * Cancellation (`tasks/cancel`) and streaming are deferred and will be added
 * at the same time as external endpoints.
 */
export interface ConsultTransport {
  send(request: ConsultRequest): Promise<ConsultResponse>
}
