/**
 * Worker system for parallel research delegation.
 *
 * Workers run restricted query loops (read-only tools, cheap model, max 10 turns).
 * Results are delivered via a notification queue that the main query loop drains
 * between turns.
 */

import { randomUUID } from 'node:crypto'

import type { LLMProvider, Message } from '../providers/types.js'
import type { Tool, ToolContext } from '../tools/types.js'
import { queryLoop, type QueryEvent } from '../engine/query-loop.js'

// ── Types ──────────────────────────────────────────────────────

export type WorkerStatus = 'running' | 'completed' | 'failed' | 'stopped'

export type WorkerResult = {
  workerId: string
  description: string
  status: WorkerStatus
  result: string
  /**
   * Session that spawned this worker. Set at spawn time from the spawning
   * turn's `context.sessionId`. The notification queue + drain are scoped by
   * this so a worker's result is delivered ONLY to its own session's turns —
   * the `createWorkerManager` singleton is shared process-wide across every
   * user and channel, and without this scope a background worker completing
   * during another user's turn bled its research into that turn (cross-tenant
   * leak, 2026-06-02). `null` only in non-route contexts (smoke / scheduled
   * jobs) where there is no session boundary.
   */
  ownerSessionId?: string | null
}

/**
 * Persistence port for askQuestion suspend-resume worker durability.
 * See docs/architecture/engine/askquestion-suspend-resume.md →
 * "Worker persistence (Phase 3)".
 *
 * The manager calls these at three points:
 *   - `recordSpawn` when `spawn()` runs (status='running' + prompt snapshot).
 *   - `recordTurn` after every LLM-turn boundary inside the worker
 *     (history_json + turn_count). This is the resume seed.
 *   - `recordCompletion` when the worker settles (result + final status).
 *
 * Row identity is the caller-generated `runId` (a UUID). Migration 190
 * originally keyed rows by (session_id, worker_id) UNIQUE, but the
 * in-process worker_id is a per-request monotonic counter that resets
 * on every reset(); cross-request collisions silently merged two
 * different workers' state into one row. Migration 194 dropped the
 * UNIQUE; runIds are now the addressable identity (worker_id stays as
 * a display label only).
 *
 * Absent in non-route contexts (smoke tests, scheduled-job execution).
 * The manager calls the methods through optional chaining so the absence
 * is a clean no-op.
 */
export type WorkerRunsStore = {
  recordSpawn(params: {
    runId: string
    sessionId: string
    workspaceId: string
    workerId: string
    description: string
    prompt: string
    researchMode: boolean
    model: string
  }): Promise<void>
  recordTurn(params: {
    runId: string
    sessionId: string
    workerId: string
    turnCount: number
    history: Message[]
  }): Promise<void>
  recordCompletion(params: {
    runId: string
    sessionId: string
    workerId: string
    status: WorkerStatus
    result: string
    turnCount: number
  }): Promise<void>
  /**
   * Load every worker row for the session — used by `rehydrate()` on
   * chat-route resume entry. The manager respawns rows with
   * status='running' (seeded with `history`) and pushes rows with
   * status='completed'|'failed'|'stopped' into the notifications queue
   * for Phase 4b drain. The `runId` flows back to `recordTurn` /
   * `recordCompletion` so respawned workers update the existing row
   * instead of inserting a new one.
   */
  loadForSession(sessionId: string): Promise<Array<{
    runId: string
    workerId: string
    status: WorkerStatus
    description: string
    prompt: string
    researchMode: boolean
    model: string
    turnCount: number
    result: string | null
    history: Message[]
  }>>
  /**
   * Hardening sweep — delete worker_runs rows whose status is
   * terminal (`completed`/`failed`/`stopped`) AND whose `updated_at` is
   * older than `cutoff`. Returns the deleted row count. Used by the
   * daily cleanup interval in apps/api so the table doesn't accumulate
   * historical research data indefinitely. Running rows are NEVER
   * deleted by this sweep — a stuck "running" row is a separate
   * triage signal, not a cleanup candidate. See
   * docs/architecture/engine/askquestion-suspend-resume.md.
   */
  deleteTerminalOlderThan(cutoff: Date): Promise<number>
}

export type WorkerOptions = {
  provider: LLMProvider
  model: string
  tools: Map<string, Tool> // restricted tool set
  maxTurns?: number
  /** Forward worker query loop events (tool_start, tool_result, etc.) to the caller. */
  onEvent?: (workerId: string, event: QueryEvent) => void
}

const WORKER_SYSTEM_PROMPT = `You are a research assistant. Your job is to find specific information and return it concisely.

Rules:
- Answer the question directly, no preamble
- Include specific details (names, prices, addresses, times)
- Format as a structured list when returning multiple items
- If you can't find what's asked, say so clearly
- Do NOT interact with the user — return your findings to the main assistant
- Use 1-2 web searches maximum per task. A single well-crafted search is almost always enough. Do NOT search for each individual item separately — search for a list/roundup instead.
- Stop searching once you have enough to answer. Don't seek exhaustive coverage.`

/**
 * Research-mode prompt — used when the parent loop is in deep-research mode
 * (Research toggle on + max-tier model). The default prompt caps web searches
 * at 1-2 and never mentions urlReader, which causes workers to return raw
 * search snippets instead of actual page content. For research turns the
 * user has explicitly asked for thoroughness, so we mandate the search →
 * read → cite chain that webSearch's own tool description already documents.
 *
 * Philosophy: depth comes from structurally-required tool sequences
 * ("you MUST call urlReader") and multi-angle fallback ("if first query is
 * thin, try 2 more"), not from aspirational language that the model can
 * ignore. Production trace
 * confirmed workers under the prior prompt called webSearch once and
 * exited — never urlReader — so the prompt is now phrased as enforcement,
 * not encouragement.
 *
 * See docs/architecture/engine/coordinator-pattern.md → "Research-mode
 * workers" for the rationale and per-turn signal flow.
 */
const WORKER_RESEARCH_SYSTEM_PROMPT = `You are a research worker. Close the one gap the coordinator briefed you on; return structured findings.

# Rules (laws)

1. **urlReader REQUIRED before responding.** No urlReader call → invalid response. Snippets are leads, not evidence.
2. **Search → read same turn.** After \`webSearch\`, emit parallel \`urlReader\` calls on 2-4 top URLs in the SAME assistant turn.
3. **Multi-angle on thin results.** ≥3 distinct query angles (different keywords / \`site:\` filters / lenses) before reporting "no info".
4. **Triangulation.** ≥2 sources = \`[high-confidence]\`; 1 source = \`[single-source]\`.
5. **Adapt on failure.** urlReader error → pivot to a different URL, never retry. All top URLs fail → new search with different query.
6. **No silent drops.** Every failed URL goes in \`<failed-sources>\` with a code.

Budget: up to 8 searches, urlReader uncapped.

# Output — REQUIRED schema

Your final text MUST be exactly this XML. No preamble. No prose outside the tags.

<worker-findings>
<self-critique>One sentence: closed the gap? If not, what's missing?</self-critique>
<findings>
- [high-confidence] Fact. Sources: https://url1, https://url2.
- [single-source] Fact. Source: https://url3.
</findings>
<gaps-remaining>- What you couldn't verify (or "none").</gaps-remaining>
<failed-sources>- https://url: failure-code (or "none").</failed-sources>
</worker-findings>

Failure codes: \`paywall\`, \`robots-blocked\`, \`js-required\`, \`empty\`, \`4xx\`, \`5xx\`, \`rate-limited\`, \`stale\`, \`off-topic\`.`

const WORKER_MAX_TURNS = 10
const WORKER_RESEARCH_MAX_TURNS = 30
/**
 * Per-worker absolute tool-call ceiling in research mode. The query-loop's
 * default cap is `DEFAULT_HARD_LIMIT` (10), which leaves a worker with only
 * 9 calls after the first webSearch — enough to read 2-3 URLs once and
 * exit, but not enough for the multi-angle, multi-round digging research
 * mode actually requires. Lift it well above the natural budget so the
 * loop-detector never trips a "deep dive" prematurely; the urlReader-or-die
 * rule in the system prompt + the per-turn budget are the real stops.
 */
const WORKER_RESEARCH_MAX_TOOL_CALLS = 40

/**
 * Research-mode user-message wrap. Prepended to the coordinator-supplied
 * prompt at spawn time so the chain-search-then-read directive shows up
 * where the model actually weights it — inside the user message — not only
 * in the system prompt. Observed in production: with the system-prompt
 * directive alone, the worker treated the coordinator's "Search for X"
 * wording as binding and exited after webSearch without ever calling
 * urlReader. The user message is the highest-signal channel for
 * sub-prompts; this wrap puts the workflow there too.
 */
const RESEARCH_USER_PROMPT_PREAMBLE = `Research protocol (echo of system prompt — follow exactly):

1. webSearch the gap (focused query) → in the SAME turn urlReader top 2-3 URLs (parallel).
2. Extract specific facts with source URLs.
3. urlReader fail → pivot URL; all fail → new search, new angle.
4. Gap not closed after round 1 → another search with a DIFFERENT angle. ≥3 distinct angles before "no info".
5. Output ONLY the \`<worker-findings>\` XML schema. No prose. No questions.

Forbidden: single search and exit; no urlReader; "no info" before 3 angles; snippet-only summary; prose instead of XML.

# Gap

`

// ── Worker manager ─────────────────────────────────────────────

export function createWorkerManager(options: WorkerOptions) {
  // `abortController` and `promise` are nullable: once the worker completes,
  // these heavy refs are nulled out so V8 can GC the queryLoop's closure
  // (provider session, accumulated text, tool definitions). Production OOM
  // 5/26 showed Map entries holding multi-MB closures across multi-wave
  // research, contributing to runaway heap growth.
  const workers = new Map<string, {
    status: WorkerStatus
    description: string
    result?: string
    // Spawning turn's session — scopes pendingCount/notification delivery so
    // one user's worker never surfaces in another user's turn on this shared
    // singleton. See WorkerResult.ownerSessionId.
    ownerSessionId: string | null
    abortController: AbortController | undefined
    promise: Promise<WorkerResult> | undefined
  }>()

  let workerCounter = 0

  // Per-request research flag — flipped via `setResearchMode` from the chat
  // route at the start of each turn that has Research mode enabled. Reset to
  // false in `reset()` so a follow-up non-research turn on the same singleton
  // doesn't inherit the loosened budget.
  let researchMode = false

  // Per-request research model override. When Research mode is on, the chat
  // route hands us the coordinator's max-tier model so workers run with the
  // same intelligence as the coordinator. Without this, workers default to
  // `options.model` (boot-time Flash) and the loosened prompt isn't enough to
  // make them chain webSearch → urlReader — they bail after one search and
  // return snippet-only summaries. Reset to null in `reset()`.
  let researchModel: string | null = null

  // Per-request concurrency cap. When set, `spawn()` returns `null` if the
  // number of currently-running workers is at or above the cap — the
  // spawnWorker tool then surfaces a structured "at capacity" error to the
  // model so it knows to wait for completions before spawning more. Null
  // means unlimited (the default). Reset to null in `reset()`.
  //
  // Research mode sets this to 10 so the coordinator can fan out broadly
  // on initial waves and refill the pool after a wave drains. Non-research
  // paths (splitter-triggered parallel research) leave it null because
  // their fan-outs are small (2-3 workers) and bounded by the classifier.
  let maxConcurrent: number | null = null

  // ── Persistence (Phase 3 of askQuestion suspend-resume) ──────────
  // Per-request store + session context. Wired by the chat route via
  // `setPersistence(...)` at the start of each turn; reset to null in
  // `reset()` so a follow-up turn on a different session doesn't write
  // to the wrong worker_runs row. Absent in worker / scheduled-job /
  // smoke contexts — the writes become no-ops.
  let persistenceStore: WorkerRunsStore | null = null
  let persistenceSessionId: string | null = null
  let persistenceWorkspaceId: string | null = null

  function persistFireAndForget(p: Promise<void>, op: string, workerId: string) {
    p.catch((err) => {
      console.warn(
        `[worker] persistence ${op} failed for ${workerId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  function countActiveWorkers(): number {
    let active = 0
    for (const w of workers.values()) {
      if (w.status === 'running') active++
    }
    return active
  }

  // ── Notification queue + wake/wait (same pattern as tool-executor.ts) ──

  const notifications: WorkerResult[] = []
  let wakeResolve: (() => void) | null = null

  function wake() {
    if (wakeResolve) {
      wakeResolve()
      wakeResolve = null
    }
  }

  function waitForChange(): Promise<void> {
    return new Promise((resolve) => {
      wakeResolve = resolve
    })
  }

  function runWorker(
    workerId: string,
    prompt: string,
    context: ToolContext,
    requestTools?: Map<string, Tool>,
    displayLabel?: string,
    /**
     * Phase 3 — rehydrate seed. When set (by `rehydrate()`), this is the
     * stateless history snapshot from the last completed turn boundary
     * before the rotation. The queryLoop picks up from this point
     * instead of starting from a single user message. Spawn-side
     * persistence write is skipped — the row already exists.
     */
    resumeHistory?: Message[],
    /**
     * Pre-existing `worker_runs.id` for rehydrated workers. When set,
     * recordTurn / recordCompletion target this row instead of inserting
     * a new one. Fresh spawns leave this undefined and the function
     * generates a new UUID.
     */
    resumeRunId?: string,
  ): Promise<WorkerResult> {
    const description = displayLabel ?? prompt.slice(0, 100)
    const abortController = new AbortController()
    const isResume = !!resumeHistory && resumeHistory.length > 0
    // Row identity for the persistence layer. A rehydrated worker
    // reuses the existing row's id so recordTurn / recordCompletion
    // overwrite the right row; a fresh spawn mints a new UUID.
    const runId = resumeRunId ?? randomUUID()

    // Use request-time tools if provided (includes MCP connectors),
    // filtered to read-only. Fall back to boot-time tools.
    const workerTools = requestTools
      ? new Map([...requestTools].filter(([_, t]) => t.isReadOnly))
      : options.tools

    // Pick the prompt + budget + model at spawn time. Per-spawn snapshot —
    // flipping `researchMode` mid-turn doesn't retroactively change a worker
    // already running, which matches `setOnEvent`'s semantics.
    const isResearch = researchMode
    const systemPrompt = isResearch ? WORKER_RESEARCH_SYSTEM_PROMPT : WORKER_SYSTEM_PROMPT
    const maxTurns = options.maxTurns
      ?? (isResearch ? WORKER_RESEARCH_MAX_TURNS : WORKER_MAX_TURNS)
    // Research workers need much more tool-call headroom than the loop
    // detector's 10-call default — a multi-angle dig is webSearch × 3+ plus
    // urlReader × 3 per round. Non-research workers keep the default so the
    // standard pre-flight path can't blow its budget.
    const maxToolCalls = isResearch ? WORKER_RESEARCH_MAX_TOOL_CALLS : undefined
    const userPrompt = isResearch
      ? `${RESEARCH_USER_PROMPT_PREAMBLE}${prompt}`
      : prompt
    const model = isResearch && researchModel ? researchModel : options.model

    // Capture per-spawn refs from the SPAWNING TURN's `context` (stable per
    // spawn), NOT the shared singleton's mutable persistence*/onEvent fields.
    // spawn() runs deep inside the awaited coordinator loop, so a concurrent
    // turn's setPersistence()/setOnEvent()/reset() can change those module
    // fields between this turn's setup and this spawn. The store HANDLE is not
    // tenant-specific (the same WorkerRunsStore for everyone) so it may come
    // from the module field; the session + workspace MUST come from context so
    // a worker's worker_runs row can never be written under — or rehydrated
    // into — another user's session/workspace (cross-tenant leak follow-up,
    // 2026-06-02). `ownOnEvent` is snapshotted for the same reason: a
    // concurrent setOnEvent() must not redirect THIS worker's events
    // (queries / URLs / findings) and its tool-cost + analytics into another
    // user's live SSE stream.
    const ownStore = persistenceStore
    const ownSessionId: string | null = context.sessionId ?? persistenceSessionId ?? null
    const ownWorkspaceId: string | null = context.workspaceId ?? persistenceWorkspaceId ?? null
    const ownerSessionId: string | null = ownSessionId
    const ownOnEvent = options.onEvent

    // Persistence — record spawn (skip when rehydrating; the row already
    // exists with `status='running'`). Fire-and-forget; a slow DB write
    // doesn't block the worker from starting.
    if (!isResume && ownStore && ownSessionId && ownWorkspaceId) {
      persistFireAndForget(
        ownStore.recordSpawn({
          runId,
          sessionId: ownSessionId,
          workspaceId: ownWorkspaceId,
          workerId,
          description,
          prompt,
          researchMode: isResearch,
          model,
        }),
        'recordSpawn',
        workerId,
      )
    }
    const messagesForLoop: Message[] = isResume && resumeHistory
      ? resumeHistory
      : [{ role: 'user', content: userPrompt }]

    // Hoisted so the catch block can include the last-known turn count
    // in `recordCompletion` for failed workers (otherwise the row would
    // show turnCount=0 even though several turns ran successfully).
    let lastTurnCount = 0
    const promise = (async (): Promise<WorkerResult> => {
      try {
        let responseText = ''
        // Structural enforcement counters for research-mode workers.
        //
        // The prompt rule "urlReader is REQUIRED" reliably fails on its
        // own — production traces showed Gemini 3.1 Pro workers running
        // webSearch and exiting without ever calling urlReader, even with
        // explicit LAW-phrased instructions. The model decides "I have
        // enough from the snippet" and bails. We backstop the prompt with
        // a tool-call count check at worker exit: if a research-mode
        // worker ran webSearches but no urlReader, we overwrite its
        // result with a synthetic "INVALID — protocol violation" payload
        // so the coordinator's gap-assessment sees a clear failure
        // signal and spawns a follow-up worker. Cheap, surgical, doesn't
        // depend on the model obeying the prompt.
        let urlReaderCalls = 0
        let webSearchCalls = 0

        for await (const event of queryLoop({
          provider: options.provider,
          model,
          systemPrompt,
          messages: messagesForLoop,
          tools: workerTools,
          context: {
            ...context,
            abortSignal: abortController.signal,
            // Workers must NOT have workerManager — otherwise Phase 4b
            // triggers inside the worker and deadlocks waiting for sibling workers.
            workerManager: undefined,
          },
          maxTurns,
          ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
          // Stateless: avoid rawHistory accumulation with thought signatures.
          // Workers are ephemeral — no need to preserve session state, and the
          // memory savings are significant (~100-200KB per thought signature blob
          // avoided per turn across 3 concurrent workers).
          stateless: true,
          // Phase 3 persistence — write the per-turn-boundary history to
          // worker_runs so a Cloud Run rotation can rehydrate from this
          // snapshot. Fire-and-forget; the engine doesn't await this.
          onTurnEnd: (turn, history) => {
            lastTurnCount = turn + 1
            if (ownStore && ownSessionId) {
              persistFireAndForget(
                ownStore.recordTurn({
                  runId,
                  sessionId: ownSessionId,
                  workerId,
                  turnCount: lastTurnCount,
                  history,
                }),
                'recordTurn',
                workerId,
              )
            }
          },
        })) {
          if (event.type === 'text_delta') {
            responseText += event.text
          }
          if (event.type === 'tool_start') {
            if (event.name === 'urlReader') urlReaderCalls++
            else if (event.name === 'webSearch') webSearchCalls++
          }
          // Forward events to the SPAWNING turn's sink (snapshotted at spawn),
          // never the singleton's live options.onEvent — see capture block.
          ownOnEvent?.(workerId, event)
        }

        // Research-mode enforcement: a worker that did webSearches without
        // urlReader is by definition snippet-only — the protocol's central
        // failure mode. Overwrite the result with a clear protocol-violation
        // payload so the coordinator sees a "failed" worker and spawns a
        // follow-up, rather than synthesising "no info" from snippet noise.
        const protocolViolation = isResearch && webSearchCalls > 0 && urlReaderCalls === 0
        const finalResult = protocolViolation
          ? `<worker-findings>
<self-critique>
INVALID OUTPUT — PROTOCOL VIOLATION. This worker ran ${webSearchCalls} webSearch call(s) but zero urlReader calls. The findings below (if any) are snippet-only and not trusted. The coordinator should respawn this gap with a fresh worker and an explicit urlReader requirement, or pivot to a different angle.
</self-critique>

<findings>
INVALID — urlReader was required by protocol but not called. Search snippets are not evidence.
</findings>

<gaps-remaining>
- Original gap UNANSWERED (urlReader skipped — research protocol violation). Respawn a follow-up worker.
</gaps-remaining>

<failed-sources>
- enforcement: worker_skipped_urlreader (${webSearchCalls} webSearch / 0 urlReader)
</failed-sources>
</worker-findings>`
          : (responseText || 'No results found.')

        if (protocolViolation) {
          console.warn(
            `[worker] Research-mode worker ${workerId} exited with ${webSearchCalls} webSearch / 0 urlReader — overwriting result with protocol-violation payload.`,
          )
        }

        const result: WorkerResult = {
          workerId,
          description,
          // Protocol violations are surfaced as `failed` (not `completed`) so
          // the coordinator's notification XML shows status=failed — clean
          // signal that this worker did NOT actually do research.
          status: protocolViolation ? 'failed' : 'completed',
          result: finalResult,
          ownerSessionId,
        }

        const entry = workers.get(workerId)
        if (entry) {
          entry.status = result.status
          entry.result = result.result
          // Drop heavy refs — abortController + promise pin the queryLoop
          // closure (provider session, accumulated text, tool defs) until
          // GC. Once the worker has settled, these are only useful for
          // getStatus / getResult / sendWorkerMessage which need just
          // status + description + result. Production OOM 5/26 confirmed
          // these closures contribute to runaway heap growth across waves.
          entry.abortController = undefined
          entry.promise = undefined
        }

        if (ownStore && ownSessionId) {
          persistFireAndForget(
            ownStore.recordCompletion({
              runId,
              sessionId: ownSessionId,
              workerId,
              status: result.status,
              result: result.result,
              turnCount: lastTurnCount,
            }),
            'recordCompletion',
            workerId,
          )
        }
        notifications.push(result)
        wake()

        return result
      } catch (err) {
        const result: WorkerResult = {
          workerId,
          description,
          status: 'failed',
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          ownerSessionId,
        }

        const entry = workers.get(workerId)
        if (entry) {
          entry.status = 'failed'
          entry.result = result.result
          entry.abortController = undefined
          entry.promise = undefined
        }

        if (ownStore && ownSessionId) {
          persistFireAndForget(
            ownStore.recordCompletion({
              runId,
              sessionId: ownSessionId,
              workerId,
              status: 'failed',
              result: result.result,
              turnCount: lastTurnCount,
            }),
            'recordCompletion',
            workerId,
          )
        }
        notifications.push(result)
        wake()

        return result
      }
    })()

    workers.set(workerId, {
      status: 'running',
      description,
      ownerSessionId,
      abortController,
      promise,
    })

    return promise
  }

  return {
    /**
     * Reset the manager for a new request — abort stale workers, clear state.
     * Call at the start of each request to prevent cross-request contamination.
     */
    reset() {
      for (const entry of workers.values()) {
        if (entry.status === 'running') {
          entry.abortController?.abort()
        }
      }
      workers.clear()
      notifications.length = 0
      workerCounter = 0
      options.onEvent = undefined
      researchMode = false
      researchModel = null
      maxConcurrent = null
      persistenceStore = null
      persistenceSessionId = null
      persistenceWorkspaceId = null
    },

    /**
     * Phase 3 of askQuestion suspend-resume — wire per-request worker
     * persistence. The chat route calls this at the start of every
     * workspace-scoped turn; on reset() the bindings clear. Without it
     * the manager runs in legacy in-memory-only mode (current behavior
     * for workers / smoke / non-route contexts).
     */
    setPersistence(params: {
      store: WorkerRunsStore | null
      sessionId: string | null
      workspaceId: string | null
    }) {
      persistenceStore = params.store
      persistenceSessionId = params.sessionId
      persistenceWorkspaceId = params.workspaceId
    },

    /**
     * Phase 3 of askQuestion suspend-resume — load every persisted worker
     * row for a session and reconstitute the manager state. Completed /
     * failed / stopped rows go straight into the notifications queue so
     * Phase 4b drains them on the next turn boundary. Running rows are
     * respawned with their saved history so they continue from the last
     * turn boundary (lossless rotation) instead of restarting from
     * scratch. Returns the count of rehydrated workers + the count of
     * pre-completed notifications loaded. Caller should pass a fresh
     * `ToolContext`; abortController + provider come from `options`.
     */
    async rehydrate(
      sessionId: string,
      context: ToolContext,
      requestTools?: Map<string, Tool>,
    ): Promise<{ respawned: number; notificationsReady: number }> {
      if (!persistenceStore) {
        return { respawned: 0, notificationsReady: 0 }
      }
      const rows = await persistenceStore.loadForSession(sessionId)
      let respawned = 0
      let notificationsReady = 0
      // Drive the workerCounter past the highest known id so a follow-up
      // spawn on this manager doesn't collide with a rehydrated row.
      // worker_id format is `worker_<n>` — extract n.
      for (const row of rows) {
        const m = row.workerId.match(/^worker_(\d+)$/)
        if (m) {
          const n = parseInt(m[1], 10)
          if (Number.isFinite(n) && n > workerCounter) workerCounter = n
        }
      }
      for (const row of rows) {
        if (row.status === 'running') {
          // Snapshot the per-request research flags so the spawn picks
          // the same prompt + budget as the original. The chat route
          // typically already called setResearchMode before rehydrate;
          // but be defensive: if a row says research_mode=true and the
          // current setting differs, the row's value wins for that
          // single respawn (we toggle, spawn, restore).
          const savedResearch = researchMode
          const savedModel = researchModel
          researchMode = row.researchMode
          researchModel = row.researchMode ? row.model : null
          try {
            runWorker(
              row.workerId,
              row.prompt,
              context,
              requestTools,
              row.description,
              row.history,
              row.runId,
            )
            respawned++
          } finally {
            researchMode = savedResearch
            researchModel = savedModel
          }
        } else {
          // Pre-completed (completed | failed | stopped). Surface the
          // result via the notifications queue exactly as if the worker
          // had just finished, so Phase 4b's drain sees no difference
          // between a same-process worker and a rehydrated one.
          const result: WorkerResult = {
            workerId: row.workerId,
            description: row.description,
            status: row.status,
            result: row.result ?? '',
            ownerSessionId: sessionId,
          }
          workers.set(row.workerId, {
            status: row.status,
            description: row.description,
            result: row.result ?? undefined,
            ownerSessionId: sessionId,
            abortController: undefined,
            promise: undefined,
          })
          notifications.push(result)
          notificationsReady++
        }
      }
      if (notificationsReady > 0) {
        wake()
      }
      return { respawned, notificationsReady }
    },

    /**
     * Set the event handler for the current request.
     * Allows the singleton manager to forward worker events to the active SSE stream.
     */
    setOnEvent(handler: ((workerId: string, event: QueryEvent) => void) | undefined) {
      options.onEvent = handler
    },

    /**
     * Toggle research mode for the current request. When true, workers spawned
     * for the rest of this request use a loosened system prompt (chain
     * webSearch → urlReader, up to 5 searches, surface blocked sources) and a
     * higher per-worker turn budget. Reset back to false in `reset()`.
     */
    setResearchMode(enabled: boolean) {
      researchMode = enabled
    },

    /**
     * Set the model used by workers for the current request. Only applied when
     * `researchMode` is also true — the chat route hands us the coordinator's
     * max-tier model so worker intelligence matches the coordinator's. Pass
     * `null` to fall back to `options.model`. Reset to null in `reset()`.
     */
    setResearchModel(model: string | null) {
      researchModel = model
    },

    /**
     * Set the max concurrent running workers for this request. `spawn()`
     * returns null (and the spawnWorker tool surfaces a structured error to
     * the model) when at capacity. Pass `null` for unlimited. Reset to null
     * in `reset()`.
     *
     * Research mode sets this to 10 so the coordinator can fan out broadly
     * on the initial wave and refill the pool after Phase 4b drains workers
     * between waves.
     */
    setMaxConcurrent(n: number | null) {
      maxConcurrent = n
    },

    /**
     * Read the current concurrency cap. Used by callers that want to surface
     * "X of N slots used" diagnostics. Returns null when no cap is set.
     */
    get maxConcurrent(): number | null {
      return maxConcurrent
    },

    /** Read the count of currently-running workers (for diagnostics). */
    get activeCount(): number {
      return countActiveWorkers()
    },

    /**
     * Spawn a new worker. Returns immediately — worker runs in the background.
     * Results arrive via the notification queue (drainNotifications). Returns
     * `null` when the concurrency cap is set and currently at capacity —
     * caller (the spawnWorker tool) should convert this to an error result
     * telling the model to wait for some workers to complete first.
     */
    spawn(prompt: string, context: ToolContext, requestTools?: Map<string, Tool>, description?: string): { workerId: string } | null {
      if (maxConcurrent !== null && countActiveWorkers() >= maxConcurrent) {
        return null
      }
      const workerId = `worker_${++workerCounter}`
      runWorker(workerId, prompt, context, requestTools, description)
      return { workerId }
    },

    /**
     * Stop a running worker.
     */
    stop(workerId: string): boolean {
      const entry = workers.get(workerId)
      if (!entry || entry.status !== 'running') return false
      entry.abortController?.abort()
      entry.status = 'stopped'
      return true
    },

    /**
     * Get the status of a worker.
     */
    getStatus(workerId: string): WorkerStatus | null {
      return workers.get(workerId)?.status ?? null
    },

    /**
     * Get the short description of a worker (first 100 chars of its prompt).
     */
    getDescription(workerId: string): string | null {
      return workers.get(workerId)?.description ?? null
    },

    /**
     * Get the result of a completed worker.
     */
    getResult(workerId: string): string | null {
      return workers.get(workerId)?.result ?? null
    },

    /**
     * Number of workers still running (unscoped — every session). Prefer
     * `pendingCountFor(sessionId)` on request paths; this stays for diagnostics
     * and legacy/test callers.
     */
    get pendingCount(): number {
      let count = 0
      for (const w of workers.values()) {
        if (w.status === 'running') count++
      }
      return count
    },

    /** Running-worker count owned by `sessionId` (or session-less workers). */
    pendingCountFor(sessionId: string): number {
      let count = 0
      for (const w of workers.values()) {
        if (w.status === 'running' && (w.ownerSessionId == null || w.ownerSessionId === sessionId)) count++
      }
      return count
    },

    /**
     * Whether there are undrained notifications in the queue (unscoped).
     * Prefer `hasNotificationsFor(sessionId)` on request paths.
     */
    get hasNotifications(): boolean {
      return notifications.length > 0
    },

    /** Whether an undrained notification is owned by `sessionId` (or session-less). */
    hasNotificationsFor(sessionId: string): boolean {
      return notifications.some((n) => n.ownerSessionId == null || n.ownerSessionId === sessionId)
    },

    /**
     * Atomically drain queued notifications and remove them from the queue.
     *
     * With `forSessionId`, drains ONLY that session's (and any session-less)
     * results, leaving other sessions' results queued for their own turns to
     * pick up — this is what prevents cross-tenant delivery on the shared
     * singleton (incident 2026-06-02). Omitting it drains everything (legacy /
     * non-route callers / tests).
     */
    drainNotifications(forSessionId?: string): WorkerResult[] {
      if (forSessionId === undefined) {
        const drained = [...notifications]
        notifications.length = 0
        return drained
      }
      const mine: WorkerResult[] = []
      const rest: WorkerResult[] = []
      for (const n of notifications) {
        if (n.ownerSessionId == null || n.ownerSessionId === forSessionId) mine.push(n)
        else rest.push(n)
      }
      notifications.length = 0
      notifications.push(...rest)
      return mine
    },

    /**
     * Wait until at least one notification arrives. With `forSessionId`, waits
     * for a notification owned by that session; resolves immediately if one is
     * already queued or no matching workers are pending. (A wake from another
     * session's worker resolves the wait too — the caller re-checks
     * `hasNotificationsFor` and loops, which is harmless and bounded by the
     * caller's poll timeout.)
     */
    async waitForNext(forSessionId?: string): Promise<void> {
      if (forSessionId === undefined) {
        if (notifications.length > 0) return
        if (this.pendingCount === 0) return
      } else {
        if (this.hasNotificationsFor(forSessionId)) return
        if (this.pendingCountFor(forSessionId) === 0) return
      }
      await waitForChange()
    },

    /**
     * Wait for all running workers to complete.
     */
    async waitAll(): Promise<WorkerResult[]> {
      // Only running workers have a non-undefined `promise` (it's cleared on
      // completion to free closure memory). Completed workers are skipped
      // since their results were already pushed to notifications.
      const promises = [...workers.values()]
        .filter((w): w is typeof w & { promise: Promise<WorkerResult> } =>
          w.status === 'running' && w.promise !== undefined,
        )
        .map((w) => w.promise)
      return Promise.all(promises)
    },

    /**
     * Format a worker result as XML notification for the main agent.
     *
     * The body is hard-capped at `MAX_NOTIFICATION_BODY_CHARS` chars to
     * prevent coordinator-session bloat across multi-wave research runs.
     * Each <worker-result> injected via Phase 4b enters the coordinator's
     * stateful session history permanently, and Gemini's per-turn thought
     * signature blob (100-200KB) stacks on top. Without truncation, 10
     * workers/wave × 4 waves with rich <worker-findings> XML (~1-3KB each)
     * plus signatures was driving the api process to a 2GB OOM (5/26 22:40
     * trace). 2000 chars keeps the most informative blocks
     * (\`<self-critique>\`, \`<findings>\`, \`<gaps-remaining>\`) for
     * typical workers and trims the tail; protocol-violation payloads are
     * already short (~500 chars) so they pass through untouched.
     */
    formatNotification(result: WorkerResult): string {
      const MAX_NOTIFICATION_BODY_CHARS = 2000
      const body = result.result.length > MAX_NOTIFICATION_BODY_CHARS
        ? `${result.result.slice(0, MAX_NOTIFICATION_BODY_CHARS)}\n[...truncated ${result.result.length - MAX_NOTIFICATION_BODY_CHARS} chars to cap coordinator-session size]`
        : result.result
      return `<worker-result>
  <worker-id>${result.workerId}</worker-id>
  <description>${result.description}</description>
  <status>${result.status}</status>
  <result>${body}</result>
</worker-result>`
    },
  }
}

export type WorkerManager = ReturnType<typeof createWorkerManager>
