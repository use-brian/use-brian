import type { z } from 'zod'
import type { CacheStore } from '../compaction/cache-tool.js'
import type { SessionStateStore } from '../memory/session-state-types.js'
import type { ConfirmationResolver, ToolConfirmationRequest } from '../mcp/types.js'
import type { Sensitivity, SensitivityAccumulator } from '../security/sensitivity.js'
import type { CompartmentAccumulator } from '../security/compartments.js'
import type { EvidenceAccumulator } from '../security/evidence.js'
import type { AttachmentCollector } from '../workspace-files/attachments.js'

// ── Tool context ───────────────────────────────────────────────

export type ToolContext = {
  userId: string
  assistantId: string
  sessionId: string
  appId: string
  channelType: string
  channelId: string
  /** Team ID when the assistant is team-owned. Used by saveMemory for team scope. */
  workspaceId?: string | null
  /**
   * The calling assistant's kind. When 'app' (team-owned distribution
   * assistants), saveMemory defaults scope to 'team' instead of 'user' so
   * voice/brand/policy facts land in team memory by default. Absent = legacy
   * caller that predates the kind=app split; treated as 'standard'.
   */
  assistantKind?: 'standard' | 'app' | 'primary'
  /**
   * Named capability grants active on the calling assistant. Populated once
   * per turn from `CapabilityStore.listActive(assistantId)`. Used by the tool
   * executor's belt-and-braces gate (a hallucinated call for a tool that
   * declares `requiresCapability` lands there and is rejected if the
   * capability is absent). The per-turn tool-list filter at route boundaries
   * uses the same set to hide privileged tools from the model in the first
   * place. Absent = empty set.
   */
  activeCapabilities?: ReadonlySet<string>
  /** Most-active messaging channel (telegram/slack). Null if user has only used web. */
  preferredChannel?: { channelType: string; channelId: string } | null
  /**
   * The Doc view the chat is currently anchored to. Set by the chat
   * route when the request originates from `apps/app-web` with a
   * `viewId` in the URL. `renderView` reads this: when present, the
   * tool appends a `data` block to the active draft's page instead of
   * minting a new draft. Absent for non-doc chat surfaces.
   */
  docViewId?: string | null
  /**
   * The current turn's user message (the plain text the user sent this turn).
   * Set by the chat route. Doc page creation (`renderPage` /
   * `createSubPage`) snapshots it as the new page's `origin_prompt` — the
   * "first prompt" the doc History panel shows. Absent on turns with no
   * fresh user message (resume / continuation turns) and in non-route
   * contexts (workers, scheduled jobs).
   */
  userMessageText?: string
  /**
   * The user's current effective timezone (IANA, e.g. 'Asia/Hong_Kong').
   * Resolved per-request in this order: (1) `X-Client-Timezone` header
   * from the originating request, (2) `users.timezone`, (3) 'UTC'.
   * Used by scheduling tools so "remind me at 2pm" binds to the zone
   * the user was in when they said it, without forcing the model to
   * guess.
   */
  userTimezone?: string
  /**
   * The originating workflow RUN id when this turn executes a workflow
   * `assistant_call` step (set by the callee executor from
   * `ConsultRequest.workflowRunId`). Blueprint record saves use it as their
   * provenance (`source_kind='workflow', source_id=<runId>`) so the next
   * run's `{{lastRun.output.<key>}}` resolves to this run's typed output.
   * Absent on every non-workflow surface.
   */
  workflowRunId?: string | null
  abortSignal: AbortSignal
  /** DB-backed cache store for cross-restart tool result persistence. */
  cacheStore?: CacheStore
  /** Session-state store for `trackCommitment` / `resolveCommitment`. See `docs/architecture/context-engine/session-state.md`. */
  sessionStateStore?: SessionStateStore

  /**
   * Q10 unification port (WU-6.3): persist a `kind='tool_invocation'` row
   * to `pending_approvals` when a `requiresConfirmation` tool pauses. The
   * returned approvalId is forwarded on the `ToolConfirmationRequest` so
   * the channel's resolve endpoint can flip the DB row on user click.
   *
   * Absent in non-route contexts (smoke tests, scheduled-job execution,
   * worker contexts) — the executor falls back to Path A (in-memory only).
   * See docs/plans/company-brain/approvals.md.
   */
  createToolInvocationApproval?: (params: {
    toolName: string
    toolInput: Record<string, unknown>
    description: string
    displayLines?: string[]
    allowPersistentApproval?: boolean
    expiresAt: Date
  }) => Promise<string>
  /**
   * askQuestion suspend-resume — persist a `kind='question'` row to
   * `pending_approvals` and return its approvalId. The query loop calls
   * this when:
   *   1. `askQuestion` is the sole tool this turn, AND
   *   2. No background workers are pending or have undrained notifications,
   *      AND
   *   3. The caller opted in via `options.questionResumeEnabled`.
   * The chat route mounts this hook for user-facing sessions. Worker /
   * scheduled-job / smoke-test contexts leave it absent → the engine
   * falls back to the legacy terminal-exit behavior. See
   * docs/architecture/engine/askquestion-suspend-resume.md.
   */
  createPendingQuestion?: (params: {
    /** The model's question text — surfaced verbatim to the user. */
    question: string
    /** The askQuestion tool_use id. The resume worker keys its synthesized
     *  tool_result by this id so the queryLoop tool_use/tool_result pairing
     *  invariant holds at re-entry. */
    toolUseId: string
    /** Defaults to now + 24h at the route layer. */
    expiresAt: Date
  }) => Promise<string>
  /**
   * Path B durability hook for **gateway tools** (notably `mcp_call`) whose
   * own `execute()` suspends for an inner tool's confirmation. The
   * tool-executor fires `options.onAwaitingApproval` only for tools it
   * sees directly; when a gateway tool routes to a hidden underlying tool,
   * the parent executor can't write `session_resume_points` because it
   * sees the wrapper's name, not the underlying one. This hook lets the
   * gateway fire the same Path B checkpoint with the **canonical
   * underlying tool name + frozen input**, so a Cloud Run restart mid-
   * confirmation replays the right tool.
   *
   * Absent in non-route contexts (smoke tests, scheduled-job execution).
   * See docs/architecture/integrations/mcp.md → Tool search pattern.
   */
  onInnerAwaitingApproval?: (event: {
    approvalId: string
    toolCallId: string
    toolName: string
    toolInput: Record<string, unknown>
    describeText: string
    expiresAt: Date
  }) => void
  /** Full tool set for the current request (used by workers to inherit MCP tools). */
  requestTools?: Map<string, Tool>
  /** Worker manager for tracking background worker lifecycle. */
  workerManager?: import('../workers/worker.js').WorkerManager

  // ── Inner-tool confirmation ──────────────────────────────────
  // These are set by the tool executor so gateway tools (mcp_call)
  // can pause for confirmation inside execute(). The notify callback
  // pushes to the query loop's pending queue and wakes the executor.

  /** Resolver for tools that need inner confirmation (e.g. mcp_call with ask policy). */
  confirmationResolver?: ConfirmationResolver
  /** Emit a confirmation request through the query loop. Wakes the executor so the event gets flushed. */
  notifyConfirmationRequired?: (request: ToolConfirmationRequest) => void
  /** Timeout for inner confirmation prompts in ms. */
  confirmationTimeoutMs?: number
  /**
   * Run `wait` OUTSIDE the executor's exclusive execution slot, then
   * re-acquire the slot before returning.
   *
   * A gateway tool raises its confirmation prompt inside `execute()`, by
   * which point it already holds the slot. Holding it across a human wait
   * stops the executor from starting any sibling — and since each sibling's
   * prompt lives inside its own `execute()`, those siblings can never prompt
   * at all, so they expire against `confirmationTimeoutMs` unseen. Wrapping
   * the wait in this port hands the slot back for the duration, which is what
   * gives the MCP path the same prompt-in-parallel / execute-in-series
   * ordering the executor applies to its own confirmation gate.
   *
   * Absent outside the tool executor (smoke tests, workflow steps) — callers
   * must fall back to awaiting directly. See
   * docs/architecture/engine/tool-executor.md → "Gateway tools confirm
   * inside `execute()`".
   */
  parkForConfirmation?: <T>(wait: () => Promise<T>) => Promise<T>

  // ── Sensitivity enforcement ──────────────────────────────────
  // See docs/architecture/platform/sensitivity.md.

  /**
   * Per-turn outbound-attachment collector for `sendFile`. The tool
   * registers attachment intent here; the channel route drains it at
   * `turn_complete` and delivers the documents (bytes resolved via
   * `FilesApi.readBytes`). Absent in contexts with no delivery surface
   * (scheduled jobs, workers, workflow steps, MCP) — `sendFile` returns an
   * honest error there. See docs/architecture/features/files.md → "sendFile".
   */
  outboundAttachments?: AttachmentCollector

  /**
   * Per-turn accumulator. Every read of a KB entry / memory / episodic row
   * calls `note(row.sensitivity)` so that subsequent write tools (saveMemory,
   * addKnowledgeEntry) can stamp rows with the max sensitivity of what the
   * model saw. Undefined = feature disabled (pre-migration / legacy paths).
   */
  sensitivity?: SensitivityAccumulator
  /**
   * Per-turn compartment accumulator (the union analogue of `sensitivity`).
   * Every read of a row calls `note(row.compartments)` so write tools stamp
   * derived rows with the high-water union of what the model saw (the
   * compartment laundering guard). Undefined = feature disabled / legacy.
   * See docs/plans/compartment-axis.md.
   */
  compartmentAccumulator?: CompartmentAccumulator
  /**
   * Per-run identifier-evidence accumulator (the mechanical anti-fabrication
   * gate for unattended runs). The tool executor `note()`s every tool
   * result; before a gated write tool executes, its validated input is
   * scanned and rejected if it contains an identifier (email / URL / handle
   * / phone) never observed this run. Threaded only by unattended callers
   * (the workflow callee executor); undefined = accumulate-and-gate off.
   * See docs/architecture/engine/identifier-provenance-gate.md.
   */
  evidence?: EvidenceAccumulator
  /**
   * True when this is a research-mode turn (the explicit `mode:'research'`
   * toggle or the adaptive research-intent upgrade). Research findings are
   * sourced from the public web, so model-driven saves (saveMemory,
   * addKnowledgeEntry, saveContact/Company/Deal) stamp `public` rather than
   * inheriting the `internal` tier of the brain-first orientation reads —
   * see `researchWriteFloor` in ../security/sensitivity.ts and
   * docs/architecture/platform/sensitivity.md → "Research-mode provenance".
   * A `confidential` source seen this turn is still a hard floor.
   */
  researchMode?: boolean
  /**
   * The viewer's max READABLE sensitivity tier — the read-filter ceiling.
   * Store predicates reject rows whose sensitivity exceeds this. For a
   * workspace turn this is `min(actingMember.clearance, assistant.clearance)`
   * so a member never reads above their own tier through a higher-clearance
   * assistant (incident 2026-06-01; see docs/architecture/platform/sensitivity.md
   * → "Read-side clearance"). Undefined = 'confidential' (passthrough) for
   * system callers like the sync worker.
   */
  clearance?: Sensitivity
  /**
   * The viewer's effective READ compartment grant (`member ∩ assistant`, the
   * MLS category axis). Threaded onto `AccessContext.compartments` for the
   * `row.compartments <@ $grant` superset clause. `null`/`undefined` = universe
   * (clause dropped); `[]` = cleared into nothing (only uncompartmented rows).
   * The read-side analogue of `clearance`. See docs/plans/compartment-axis.md.
   */
  compartments?: string[] | null
  /**
   * The assistant's OWN clearance — the WRITE ceiling. The tool-executor
   * write gate rejects a write whose requested `sensitivity` exceeds this,
   * independent of the read ceiling above — so a member using a higher-
   * clearance assistant can still author at the assistant's tier while
   * reads stay bounded to the member. Undefined → falls back to `clearance`
   * (pre-split behavior / system callers).
   */
  assistantClearance?: Sensitivity
  /**
   * The assistant's OWN compartment grant — the WRITE ceiling for the
   * compartment axis. The tool-executor write-gate rejects a write whose
   * resolved `compartments` are not ⊆ this grant (you cannot author into a
   * compartment you are not cleared for). `null`/`undefined` = universe (no
   * gate). Also the third source of the write stamp's union (alongside the
   * explicit arg + the accumulator), via the assistant's `default_compartments`.
   */
  assistantCompartments?: string[] | null
  /**
   * The assistant's `default_compartments` — the auto-stamp the write path
   * unions onto every row this assistant authors (must be ⊆ `assistantCompartments`).
   * The compartment analogue of how the assistant's clearance seeds default
   * extraction sensitivity. See docs/plans/compartment-axis.md.
   */
  assistantDefaultCompartments?: string[]
}

// ── Tool result ────────────────────────────────────────────────

/**
 * Internal-only metadata a tool can attach to its result for observability.
 * Never serialized to the model (tool-executor only serializes `.data`/`.isError`)
 * and never persisted to the session_messages JSONB. Consumed by the analytics
 * log site in the chat route to enrich `tool_executed` event metadata —
 * e.g. which search provider served a `webSearch` call.
 */
export type ToolResultMeta = Record<string, string | number | boolean>

/** Inline base64 image a tool produces for the model to SEE (not just read as text). */
export type ToolResultImage = { mimeType: string; data: string }

export type ToolResult<T = unknown> = {
  data: T
  isError?: boolean
  meta?: ToolResultMeta
  /**
   * Optional inline images the tool produced for the model to look at. The
   * engine emits these as `image` content blocks appended to the tool-results
   * user turn, so a multimodal provider (Gemini → inlineData) sees them; a
   * text-only provider drops them. The primary producer is an MCP tool whose
   * CallToolResult carries `type:'image'` content (see mcp/client.ts).
   */
  images?: ToolResultImage[]
}

// ── Tool definition ────────────────────────────────────────────

export type Tool<Input extends z.ZodType = z.ZodType> = {
  name: string
  description: string
  inputSchema: Input

  execute(input: z.infer<Input>, context: ToolContext): Promise<ToolResult>

  // Safety metadata (fail-closed defaults applied by buildTool)
  isConcurrencySafe: boolean
  isReadOnly: boolean
  requiresConfirmation: boolean
  /**
   * Capability name required to use this tool (e.g. `bug_triage`). When set,
   * the per-turn tool-list filter excludes this tool unless the calling
   * assistant carries an active grant for the named capability. The tool
   * executor also re-checks at invocation so a stale toolset reference or
   * hallucinated call from a non-privileged assistant cannot slip through.
   * See `packages/core/src/tools/capability-gate.ts`.
   */
  requiresCapability?: string

  /**
   * When true, this tool is dropped from the *model-visible* tool list — it
   * never appears in any assistant's toolset, so the model can't choose it —
   * yet it stays a callable function for back-compat: server-side/internal
   * invocation, tests, and gateway tools that route to it by name. Use for
   * deprecated aliases that must keep working while being removed from the
   * model's surface (the scheduled-job verbs folded into the workflow surface).
   * Enforced in `tools/capability-gate.ts` (the single model-visibility gate).
   */
  hiddenFromModel?: boolean

  /**
   * Dynamic confirmation check — called at execution time instead of
   * the static `requiresConfirmation` flag. Used by MCP tools to
   * check the effective policy (user override) from the database,
   * and by built-in tools to check whitelists against the tool input.
   */
  resolveConfirmation?: (context: ToolContext, input?: unknown) => Promise<boolean>

  /**
   * Build human-readable lines for the confirmation prompt. Called by the
   * tool executor just before emitting the confirmation event. Returning
   * `null`/`undefined` falls back to the generic `formatConfirmationInput`
   * renderer in the channel route. Used by `deleteMemory` to show memory
   * summaries instead of opaque UUIDs. Input is typed as `unknown` so the
   * non-generic `Tool` surface used by the tool map doesn't collapse — the
   * hook can cast / re-parse as needed.
   */
  describeConfirmation?: (
    input: unknown,
    context: ToolContext,
  ) => Promise<string[] | null | undefined>

  /**
   * Whether "Always Allow" / "Always Deny" make sense for this tool. Only
   * MCP tools persist the decision (via `mcp_tool_settings`), so built-in
   * tools default to `false` — each call targets a distinct entity and a
   * persistent decision would be misleading.
   */
  allowPersistentApproval?: boolean

  /**
   * When true, repeated calls with IDENTICAL input are legitimate for this
   * tool, and the loop detector's (name, input) nudge/block thresholds skip
   * it — the per-turn hard limit and the failure fuses still apply. For
   * polling / re-read tools whose input is empty by design (browserSnapshot,
   * browserCurrentUrl): five identical no-arg calls is normal re-checking of
   * a changing page, not a loop, and the block message's "change the input
   * meaningfully" is impossible advice for a no-arg tool.
   */
  allowsRepeatCalls?: boolean

  // Optional
  abortSiblingsOnError?: boolean
  interruptBehavior?: 'cancel' | 'block'
  timeoutMs?: number
  maxResultSizeChars?: number
}

// ── buildTool factory ──────────────────────────────────────────

type ToolDefaults = Pick<Tool, 'isConcurrencySafe' | 'isReadOnly' | 'requiresConfirmation'>

const TOOL_DEFAULTS: ToolDefaults = {
  isConcurrencySafe: false,
  isReadOnly: false,
  requiresConfirmation: false,
}

type ToolInput<Input extends z.ZodType> = Omit<Tool<Input>, keyof ToolDefaults> & Partial<ToolDefaults>

export function buildTool<Input extends z.ZodType>(def: ToolInput<Input>): Tool<Input> {
  return { ...TOOL_DEFAULTS, ...def }
}
