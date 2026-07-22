/**
 * The computer-use tool surface (spec §3): five discrete browser tools over
 * the `BrowserProvider` seam, browsing AS a profile (R2-4/R2-10), backend
 * picked by the live toggle seeded from `profile.defaultBackend` (R2-3),
 * send-gated (§8 "no unattended state-change"), fused (P1.8), and
 * hard-blocked on autonomous paths unless unattended computer-use is enabled
 * AND the workspace is on a paid plan (Barrier 2 + R2-8). Plus one
 * sends-forbidden reader, `browserReadPage` (§12 "Part 2") — research
 * workers' only browser surface, deliberately NOT in the boot tool map.
 *
 * Registered at boot via the files pattern: rows in
 * `OFFICIAL_CONNECTOR_TOOLS.computer` + `BOOT_INJECTED_BUILTIN_TOOLS.computer`
 * (governance display) and `allTools.set(...)` in packages/api/src/boot.ts
 * (runtime injection). Layer 1 never names these tools.
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolResult } from '../tools/types.js'
import { isAutonomousToolContext } from '../tools/capability-gate.js'
import type { Sensitivity } from '../security/sensitivity.js'
import { estimateStringTokens } from '../compaction/compact.js'
import {
  looksLikeCaptcha,
  looksLikeConnectionBlock,
  looksLikeLoginWall,
  registrableSiteOf,
} from './orchestrator.js'
import {
  describeProfileResolution,
  resolveProfileForCall,
  type BrowserBackendKind,
  type BrowserProfile,
  type BrowserProfileStore,
} from './profiles.js'
import {
  BrowserBackendError,
  type BrowserCallContext,
  type BrowserProvider,
  type BrowserSnapshot,
  type SessionVault,
} from './types.js'

// ── Policy hook (the files-tools pattern) ──────────────────────

export type ComputerToolPolicy = 'allow' | 'ask' | 'block'

export type ResolveComputerToolPolicy = (
  toolName: string,
  context: { userId: string; assistantId: string },
) => Promise<ComputerToolPolicy>

// ── Audit events (boot logs these to analytics — metadata only) ─

export type ComputerToolEvent = {
  type: 'browser_action'
  op: 'navigate' | 'snapshot' | 'click' | 'type' | 'currentUrl' | 'readPage'
  backend: BrowserBackendKind
  /** Hostname only — never the full URL, never page content. */
  host: string | null
  ok: boolean
  code?: string
  /**
   * What this action ADDED TO CONTEXT — the only per-action cost signal a
   * browse has. The LOCAL backend books no sandbox-seconds and writes no
   * `usage_tracking` row of its own (metering is orchestrator-gated, and the
   * local provider bypasses the orchestrator), so a local browse's entire cost
   * is the tokens its results occupy inside the parent turn's single
   * `main_response` row — unattributable without this.
   *
   * Size only: a char count and a token ESTIMATE, never content. The estimate
   * is `estimateStringTokens` (CJK-aware) rather than chars/4, which
   * undercounts a CJK page roughly twofold. Both are recorded so the estimate
   * stays auditable against the raw length.
   *
   * Measured pre-cap, i.e. what the tool returned; `tool-executor.ts` may then
   * clamp it to `maxResultSizeChars` (24_000 for browser tools) or to
   * `MAX_TOOL_RESULT_TOKENS`. Absent on failure paths, which return no result.
   *
   * **Each event carries only the bytes ITS OWN operation contributed, so the
   * events of a turn sum to that turn's browser bytes without double counting.**
   * `navigate` and `click` fold in a follow-up snapshot and emit a PAIRED
   * `snapshot` event (same timestamp) that carries those bytes — so their own
   * event is deliberately unsized, since its non-snapshot text is a ~30-char
   * prefix. Read "what did a navigate cost" as the pair, not the row.
   */
  resultChars?: number
  resultTokens?: number
}

// ── Send gate ──────────────────────────────────────────────────

/**
 * Accessible names that make a click a state-changing "send": these require
 * confirmation/approval before executing (spec §3 browserClick). Keep this
 * list in sync with computer-use.md §3.
 */
export const SEND_LIKE_LABEL_PATTERN =
  /\b(send|submit|post|publish|share|buy|pay|purchase|order|confirm|delete|apply)\b/i

// ── Fuse (P1.8) ────────────────────────────────────────────────
//
// EPISODE-scoped, not session-lifetime: the caps bound one continuous
// stretch of browsing (a runaway model loop), and the counters reset after
// an idle gap. Without the reset, a long-lived chat session (Telegram lives
// for days) permanently bricks 15 minutes after its FIRST browser call —
// the "stops mid-task and never browses again" incident shape.

export const DEFAULT_FUSE_MAX_CALLS = 40
export const DEFAULT_FUSE_MAX_WALL_MS = 15 * 60 * 1000
const DEFAULT_FUSE_IDLE_RESET_MS = 5 * 60 * 1000

// ── Options ────────────────────────────────────────────────────

/**
 * Profile plumbing for the browse tools (R2-4/R2-10): the store + vault used
 * by `resolveProfileForCall`, and the acting assistant's clearance (boot
 * resolves it from the assistant row — never model input). Null → the
 * profile-less posture (OSS boot without the closed store).
 */
export type ComputerToolProfiles = {
  store: BrowserProfileStore
  vault?: SessionVault | null
  assistantClearance: (context: ToolContext) => Promise<Sensitivity>
}

export type CreateComputerToolsOptions = {
  local: BrowserProvider
  cloud: BrowserProvider
  /** Whether a cloud sandbox backend is configured (the toggle's default). */
  cloudAvailable?: () => boolean
  /** Browser profiles (R2-4/R2-10). Null → identity-less browsing only. */
  profiles?: ComputerToolProfiles | null
  /** L1/L2 allow/ask/block resolution (mcp_tool_settings, serverName='computer'). */
  resolvePolicy?: ResolveComputerToolPolicy
  onEvent?: (event: ComputerToolEvent, context: ToolContext) => void
  /**
   * Barrier 2 (§4.9): the unattended acting path. Defaults to () => false —
   * autonomous (headless) turns get a hard refusal from every browser tool.
   * Boot may enable it ONLY when full 3-line metering is live.
   */
  unattendedEnabled?: () => boolean
  /**
   * R2-8: unattended computer-use is a PAID-plan capability — free stays
   * interactive/watched only. Absent resolver = treated as free (fail-closed).
   */
  getWorkspacePlan?: (workspaceId: string) => Promise<string>
  /**
   * Channel escalate-to-web (§4.8): the Take-Over live-view deep link for
   * this chat session. When a CLOUD navigation lands on a login wall, the
   * tool result carries this link so the assistant can hand the user a
   * one-tap way to sign in; the session is then captured to the vault and
   * future tasks skip the login. Null/absent → no escalation hint.
   */
  takeoverLinkFor?: (context: ToolContext) => string | null
  /**
   * Fired when a cloud navigation hits a login wall: the orchestrator pauses
   * the sandbox for the Take-Over wait (§4.8 — RAM freed, cookies preserved;
   * the live view resumes it when the user arrives).
   */
  onCloudLoginWall?: (context: ToolContext) => Promise<void>
  /**
   * Fired ONCE per chat session the first time a CLOUD browse starts (§5):
   * hands the user the Take-Over live-view link proactively, before the
   * assistant does any work, so they are told where to watch at the START.
   * Channel surfaces (Telegram/Slack/WhatsApp) have no live chip and drop
   * mid-turn model text (`assembleDeliverableText`), so the model relaying
   * the link cannot be relied on there — boot backs this with an out-of-band
   * `deliverToChannel` push. `takeoverUrl` is the same session-keyed deep
   * link `takeoverLinkFor` builds. Interactive sessions only (a headless
   * autonomous run has no live watcher, so the tool never fires it).
   */
  onCloudSessionStarted?: (context: ToolContext, info: { takeoverUrl: string }) => Promise<void>
  fuse?: { maxCallsPerSession?: number; maxWallMsPerSession?: number; idleResetMs?: number }
  now?: () => number
}

// ── Per-chat-session browsing state ────────────────────────────

type SessionBrowseState = {
  /** The backend the session is currently browsing on. */
  backend: BrowserBackendKind
  /** The live toggle (R2-3): a user flip that wins for this session. */
  backendOverride: BrowserBackendKind | null
  /** The profile the session browses as (R2-4/R2-10), once resolved. */
  profileId: string | null
  profileName: string | null
  /** ref → accessible name from the LATEST snapshot (send-gate + previews). */
  refLabels: Map<string, string>
  /** Last text typed this session (approval preview context). */
  lastTyped: string | null
  calls: number
  firstCallAt: number
  /** Last gated browser call — the idle-gap clock for the episode reset. */
  lastCallAt: number
  /** Consecutive snapshots showing a human-verification challenge (§5). */
  captchaHits: number
  /**
   * The proactive live-view link has been handed to the user for this
   * session (§5) — pushed once, on the first cloud browse, never repeated.
   */
  takeoverAnnounced: boolean
}

const MAX_TRACKED_SESSIONS = 500
const SNAPSHOT_MAX_LINES = 150

export type ComputerTools = {
  browserNavigate: Tool
  browserSnapshot: Tool
  browserClick: Tool
  browserType: Tool
  browserCurrentUrl: Tool
  /**
   * The sends-forbidden one-shot reader (computer-use.md §12 "Part 2"):
   * navigate + snapshot as one atomic, serialized, identity-less, cloud-only
   * call. NOT registered into the boot tool map — boot hands it exclusively
   * to the WorkerManager for research workers.
   */
  browserReadPage: Tool
  /**
   * The live backend toggle (R2-3): a user flip that wins for the session
   * (the Profile-Management/computer routes call this; `null` clears it back
   * to the profile default). In-memory, api-instance-local — same lifetime
   * as the rest of the session browse state.
   */
  setSessionBackendOverride: (sessionId: string, backend: BrowserBackendKind | null) => void
  getSessionBackend: (sessionId: string) => BrowserBackendKind | null
}

export function createComputerTools(opts: CreateComputerToolsOptions): ComputerTools {
  const now = opts.now ?? Date.now
  const unattendedEnabled = opts.unattendedEnabled ?? (() => false)
  const cloudAvailable = opts.cloudAvailable ?? (() => false)
  const maxCalls = opts.fuse?.maxCallsPerSession ?? DEFAULT_FUSE_MAX_CALLS
  const maxWallMs = opts.fuse?.maxWallMsPerSession ?? DEFAULT_FUSE_MAX_WALL_MS
  const idleResetMs = opts.fuse?.idleResetMs ?? DEFAULT_FUSE_IDLE_RESET_MS

  const sessions = new Map<string, SessionBrowseState>()

  function sessionState(context: ToolContext): SessionBrowseState {
    let state = sessions.get(context.sessionId)
    if (!state) {
      state = {
        backend: cloudAvailable() ? 'cloud' : 'local',
        backendOverride: null,
        profileId: null,
        profileName: null,
        refLabels: new Map(),
        lastTyped: null,
        calls: 0,
        firstCallAt: now(),
        lastCallAt: now(),
        captchaHits: 0,
        takeoverAnnounced: false,
      }
      sessions.set(context.sessionId, state)
      if (sessions.size > MAX_TRACKED_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
    }
    return state
  }

  function callCtx(context: ToolContext, state?: SessionBrowseState): BrowserCallContext {
    return {
      userId: context.userId,
      workspaceId: context.workspaceId ?? '',
      sessionId: context.sessionId,
      ...(state?.profileId ? { profileId: state.profileId } : {}),
    }
  }

  function providerFor(kind: BrowserBackendKind): BrowserProvider {
    return kind === 'local' ? opts.local : opts.cloud
  }

  /**
   * Backend choice (R2-3): the live toggle wins; otherwise the profile's
   * `defaultBackend` seeds it; otherwise cloud-when-available. A cloud pick
   * degrades to local when no sandbox backend is configured.
   */
  function resolveBackend(state: SessionBrowseState, profile: BrowserProfile | null): BrowserBackendKind {
    const picked =
      state.backendOverride ?? profile?.defaultBackend ?? (cloudAvailable() ? 'cloud' : 'local')
    return picked === 'cloud' && !cloudAvailable() ? 'local' : picked
  }

  /**
   * All browser tools refuse on autonomous paths unless unattended mode is
   * live (§8, Barrier 2) AND the workspace is paid (R2-8 — free plans stay
   * interactive/watched only; a missing plan resolver fails closed).
   */
  async function autonomousGate(context: ToolContext): Promise<ToolResult | null> {
    if (!isAutonomousToolContext(context)) return null
    if (!unattendedEnabled()) {
      return {
        data:
          'ERROR: Browser tools are unavailable on autonomous runs. Computer use acts on a real browser, so it needs a live user in the loop; ask the user to run this from chat.',
        isError: true,
      }
    }
    const plan = opts.getWorkspacePlan
      ? await opts.getWorkspacePlan(context.workspaceId ?? '').catch(() => 'free')
      : 'free'
    if (plan === 'free') {
      return {
        data:
          'ERROR: Unattended computer use is available on paid plans only. The user can upgrade the workspace plan, or run this from chat.',
        isError: true,
      }
    }
    return null
  }

  /**
   * P1.8 safety fuse: hard call + wall-clock caps per EPISODE — one
   * continuous stretch of browsing. An idle gap longer than `idleResetMs`
   * starts a fresh episode, so a capped session recovers once the loop
   * actually stops; without this, long-lived sessions brick permanently.
   */
  function fuseGate(state: SessionBrowseState): ToolResult | null {
    if (now() - state.lastCallAt > idleResetMs) {
      state.calls = 0
      state.firstCallAt = now()
    }
    if (state.calls >= maxCalls) {
      return {
        data: `ERROR: This browsing stretch hit the safety cap (${maxCalls} browser actions). Summarize progress and what remains, and ask the user how to proceed — browsing unlocks after a few quiet minutes.`,
        isError: true,
      }
    }
    if (now() - state.firstCallAt > maxWallMs) {
      return {
        data: `ERROR: This browsing stretch hit the wall-clock safety cap (${Math.round(maxWallMs / 60000)} minutes of continuous browser work). Summarize progress and what remains, and ask the user how to proceed — browsing unlocks after a few quiet minutes.`,
        isError: true,
      }
    }
    return null
  }

  async function policyBlockGate(toolName: string, context: ToolContext): Promise<ToolResult | null> {
    if (!opts.resolvePolicy) return null
    try {
      const policy = await opts.resolvePolicy(toolName, {
        userId: context.userId,
        assistantId: context.assistantId,
      })
      if (policy === 'block') {
        return {
          data: `ERROR: "${toolName}" is blocked by tool policy for this assistant. A workspace member can change it under Studio > Connectors > Computer.`,
          isError: true,
        }
      }
    } catch {
      return null // policy outage must not take the tools down (files precedent)
    }
    return null
  }

  function policyAsk(toolName: string): (context: ToolContext) => Promise<boolean> {
    return async (context) => {
      if (!opts.resolvePolicy) return false
      try {
        return (
          (await opts.resolvePolicy(toolName, {
            userId: context.userId,
            assistantId: context.assistantId,
          })) === 'ask'
        )
      } catch {
        return false
      }
    }
  }

  /**
   * Size of a tool result, for the audit event. Mirrors `doc/context-meter.ts`
   * (which does this for doc-page tools) — observability, never billing.
   */
  function sized(data: string): { resultChars: number; resultTokens: number } {
    return { resultChars: data.length, resultTokens: estimateStringTokens(data) }
  }

  function emit(event: ComputerToolEvent, context: ToolContext): void {
    try {
      opts.onEvent?.(event, context)
    } catch {
      /* audit must never break the tool */
    }
  }

  function hostOf(url: string): string | null {
    try {
      return new URL(url).hostname
    } catch {
      return null
    }
  }

  /** Shared pre-execution gates. Returns an error result or the live state. */
  async function gates(
    toolName: string,
    context: ToolContext,
  ): Promise<{ error: ToolResult } | { state: SessionBrowseState }> {
    const autonomous = await autonomousGate(context)
    if (autonomous) return { error: autonomous }
    const blocked = await policyBlockGate(toolName, context)
    if (blocked) return { error: blocked }
    const state = sessionState(context)
    const fused = fuseGate(state)
    if (fused) return { error: fused }
    state.calls += 1
    state.lastCallAt = now()
    return { state }
  }

  function backendErrorResult(err: unknown, backend?: BrowserBackendKind): ToolResult {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof BrowserBackendError ? err.code : undefined
    // Connection-level block (§5): the site refused the connection before any
    // page loaded, so there is NOTHING to see, watch, or take over. On the
    // cloud backend this is almost always the anti-bot edge dropping the
    // datacenter IP. The model must not offer a dead live-view / take-over
    // link (the Cathay Pacific dead end, 2026-07-21) nor retry the same
    // address — it must report the block honestly. `sanitizeDeliveryText`
    // cannot catch this; the honesty lives in the tool result the model reads.
    if (backend === 'cloud' && looksLikeConnectionBlock(message)) {
      return {
        data:
          `ERROR: ${message}\n\n` +
          'The site refused the connection before any page could load, so there is no page to see, watch, or take over. ' +
          "This is commonly an anti-bot edge (for example Akamai or DataDome) rejecting the cloud browser's datacenter network address; it can also be a transient network fault. " +
          'Do NOT offer the user a live-browser or take-over link for this, and do not retry the same address. ' +
          'Report plainly that this site blocks automated browsing from this environment; the reliable way through a wall like this is to browse from a real browser on the user\'s own machine, which they can connect in Settings under Browser profiles ("My Browser").',
        isError: true,
        meta: { ...(code ? { code } : {}), connectionBlock: true },
      }
    }
    if (err instanceof BrowserBackendError) {
      return { data: `ERROR: ${err.message}`, isError: true, meta: { code: err.code } }
    }
    return {
      data: `ERROR: ${message}`,
      isError: true,
    }
  }

  function renderSnapshot(snapshot: BrowserSnapshot): string {
    const lines = snapshot.nodes
      .slice(0, SNAPSHOT_MAX_LINES)
      .map((n) => {
        const value = n.value ? ` value=${JSON.stringify(n.value)}` : ''
        const disabled = n.disabled ? ' (disabled)' : ''
        return `${n.ref} ${n.role} ${JSON.stringify(n.name)}${value}${disabled}`
      })
    const truncated =
      snapshot.nodes.length > SNAPSHOT_MAX_LINES
        ? `\n… ${snapshot.nodes.length - SNAPSHOT_MAX_LINES} more interactive nodes (act on what you see, or navigate closer)`
        : ''
    return `Page: ${snapshot.title || '(untitled)'}\nURL: ${snapshot.url}\n${lines.join('\n')}${truncated}`
  }

  /**
   * Captcha posture (§5): detect the challenge from the snapshot, allow ONE
   * attempt at a simple verification (checkbox / press-and-hold), then hand
   * the human the Take-Over live view instead of burning turns against a
   * wall built to defeat exactly this. Consecutive sightings escalate; any
   * captcha-free snapshot resets the count.
   */
  function captchaAdvice(context: ToolContext, state: SessionBrowseState, snapshot: BrowserSnapshot): string {
    if (!looksLikeCaptcha(snapshot)) {
      state.captchaHits = 0
      return ''
    }
    state.captchaHits += 1
    const link = state.backend === 'cloud' ? opts.takeoverLinkFor?.(context) : null
    if (state.captchaHits === 1) {
      return (
        '\n\nNOTE: This page is showing a human-verification challenge (captcha). If a simple verification element is visible (an "I\'m not a robot" checkbox, a press-and-hold button), try it ONCE.' +
        (link
          ? ` If the challenge persists, do not keep retrying — send the user this live-browser link so they can solve it themselves, then wait for their go-ahead: ${link}`
          : ' If the challenge persists, do not keep retrying — ask the user to complete it in the browser, then continue.')
      )
    }
    // Second consecutive sighting: the attempt did not clear it. Pause the
    // sandbox for the take-over wait (same economy as the login wall).
    if (state.backend === 'cloud') {
      void opts.onCloudLoginWall?.(context)?.catch(() => undefined)
    }
    return (
      '\n\nSTOP: the human-verification challenge is still blocking after an attempt. Do not retry again' +
      (link
        ? ` — send the user this live-browser link to solve it and wait for their confirmation before continuing: ${link}`
        : ' — ask the user to complete the verification in the browser, and wait for their confirmation before continuing.')
    )
  }

  /**
   * Advice for a freshly-taken snapshot: captcha first (§5 captcha posture),
   * then LATE login walls — the navigate-time wall branch only sees the URL
   * the navigation landed on, so a wall reached several clicks later
   * (session expiry, a gated step in a flow) surfaces here instead. Same
   * treatment: pause for the take-over wait + hand the user the live view.
   * Matters most on channel surfaces (Telegram/Slack), which have no live
   * chip and rely on the model relaying the link.
   */
  function pageAdvice(context: ToolContext, state: SessionBrowseState, snapshot: BrowserSnapshot): string {
    const captcha = captchaAdvice(context, state, snapshot)
    if (captcha) return captcha
    if (state.backend === 'cloud' && looksLikeLoginWall(snapshot.url)) {
      void opts.onCloudLoginWall?.(context)?.catch(() => undefined)
      const link = opts.takeoverLinkFor?.(context)
      return (
        '\n\nNOTE: the page is now asking for a login.' +
        (link
          ? ` Ask the user to sign in through the live browser view: ${link} — after they sign in once, the session is saved and future tasks on this site will not ask again. Wait for them before retrying.`
          : ' Ask the user to sign in via the live browser view, then retry.')
      )
    }
    return ''
  }

  /**
   * The round-trip saver: navigate/click take the follow-up snapshot INSIDE
   * the same tool call — one model turn per browse step instead of two, and
   * one fuse tick instead of two. Refreshes the send-gate's ref labels;
   * failure degrades to the old "take browserSnapshot" instruction instead
   * of failing the action that already succeeded.
   */
  async function inlineSnapshot(
    context: ToolContext,
    state: SessionBrowseState,
    backend: BrowserBackendKind,
  ): Promise<{ snapshot: BrowserSnapshot; rendered: string } | null> {
    try {
      const snapshot = await providerFor(backend).snapshot(callCtx(context, state))
      state.refLabels = new Map(snapshot.nodes.map((n) => [n.ref, n.name]))
      const rendered = renderSnapshot(snapshot)
      // This is the expensive one: navigate and click fold their follow-up
      // snapshot in here to save a model turn, so they cost snapshot-sized
      // context even though they read like cheap actions.
      emit(
        {
          type: 'browser_action',
          op: 'snapshot',
          backend,
          host: hostOf(snapshot.url),
          ok: true,
          ...sized(rendered),
        },
        context,
      )
      return { snapshot, rendered }
    } catch {
      return null
    }
  }

  // ── browserNavigate ──────────────────────────────────────────

  const browserNavigate = buildTool({
    name: 'browserNavigate',
    description:
      'Open a URL in the controlled browser and get back the page\'s interactive elements as refs (@e1 button "Send") in the same call — no separate browserSnapshot needed after navigating. Public sites need NO browser profile; a profile (a saved login identity) is used automatically when one is enabled — pass "profile" to pick one by name when several match.',
    inputSchema: z.object({
      url: z.string().min(1).describe('Absolute http(s) URL to open'),
      profile: z
        .string()
        .max(120)
        .optional()
        .describe('Browser profile name to browse as (needed only when several profiles match)'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('browserNavigate'),
    timeoutMs: 90_000,
    maxResultSizeChars: 24_000,
    async execute(input, context) {
      const gate = await gates('browserNavigate', context)
      if ('error' in gate) return gate.error
      let parsed: URL
      try {
        parsed = new URL(input.url)
      } catch {
        return { data: `ERROR: "${input.url}" is not a valid absolute URL.`, isError: true }
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { data: 'ERROR: Only http(s) URLs can be opened in the browser.', isError: true }
      }
      // Profile at call time (R2-10): one match auto-selects, several force a
      // name, a named miss / gate denial is an honest error. No profile
      // config (OSS) or no profiles → identity-less browse.
      let profile: BrowserProfile | null = null
      if (opts.profiles) {
        const resolution = await resolveProfileForCall({
          store: opts.profiles.store,
          vault: opts.profiles.vault,
          actor: {
            userId: context.userId,
            workspaceId: context.workspaceId ?? '',
            assistantId: context.assistantId,
            assistantClearance: await opts.profiles.assistantClearance(context),
          },
          site: registrableSiteOf(input.url),
          profileName: input.profile ?? gate.state.profileName,
        })
        if (resolution.kind === 'ok') {
          profile = resolution.profile
        } else if (resolution.kind !== 'none') {
          return { data: `ERROR: ${describeProfileResolution(resolution)}`, isError: true }
        }
      }
      gate.state.profileId = profile?.id ?? null
      gate.state.profileName = profile?.name ?? null
      const backend = resolveBackend(gate.state, profile)
      gate.state.backend = backend
      gate.state.refLabels.clear()
      try {
        const res = await providerFor(backend).navigate(callCtx(context, gate.state), input.url)
        emit({ type: 'browser_action', op: 'navigate', backend, host: hostOf(res.url), ok: true }, context)
        // Proactive live-view hand-off (§5): the moment cloud browsing starts,
        // push the user the Take-Over link out-of-band, ONCE per session,
        // before any browse work. Channel surfaces have no live chip and drop
        // mid-turn model text (`assembleDeliverableText`), so relying on the
        // model to relay the link fails there; this guarantees the user is
        // told where to watch at the start. Interactive sessions only — a
        // headless autonomous run has no live watcher.
        if (backend === 'cloud' && !gate.state.takeoverAnnounced && !isAutonomousToolContext(context)) {
          gate.state.takeoverAnnounced = true
          const startLink = opts.takeoverLinkFor?.(context) ?? null
          if (startLink) {
            void opts.onCloudSessionStarted?.(context, { takeoverUrl: startLink })?.catch(() => undefined)
          }
        }
        // Cloud login wall → escalate to the web Take-Over live view (§4.8).
        if (backend === 'cloud' && looksLikeLoginWall(res.url)) {
          try {
            await opts.onCloudLoginWall?.(context)
          } catch {
            /* pausing is an economy, never a correctness requirement */
          }
          const link = opts.takeoverLinkFor?.(context)
          return {
            data:
              `Opened ${res.url} (cloud browser) but the site is asking for a login.` +
              (link
                ? ` Ask the user to sign in through the live browser view: ${link} — after they sign in once, the session is saved and future tasks on this site will not ask again. Wait for them before retrying.`
                : ' Ask the user to sign in via the web app\'s live browser view, then retry.'),
            meta: { backend, loginWall: true },
          }
        }
        // The live view is not only for login walls: sites like Instagram
        // embed their login form at a plain URL the wall regex can never
        // match, and "let me watch / take over" is a user ask the model must
        // be able to answer. Every cloud navigate carries the link.
        const liveLink = backend === 'cloud' ? opts.takeoverLinkFor?.(context) : null
        const snap = await inlineSnapshot(context, gate.state, backend)
        const advice = snap ? pageAdvice(context, gate.state, snap.snapshot) : ''
        return {
          data:
            `Opened ${res.url} (${backend} browser).` +
            (liveLink
              ? ` The user has already been sent this live-view link to watch or take over (e.g. to sign in): ${liveLink}. Only repeat it if they ask again.`
              : '') +
            (snap ? `\n\n${snap.rendered}` : ' Take browserSnapshot to see the page.') +
            advice,
          meta: {
            backend,
            ...(liveLink ? { takeoverUrl: liveLink } : {}),
            ...(snap ? { nodes: snap.snapshot.nodes.length } : {}),
          },
        }
      } catch (err) {
        emit(
          {
            type: 'browser_action',
            op: 'navigate',
            backend,
            host: hostOf(input.url),
            ok: false,
            code: err instanceof BrowserBackendError ? err.code : undefined,
          },
          context,
        )
        return backendErrorResult(err, backend)
      }
    },
  })

  // ── browserSnapshot ──────────────────────────────────────────

  const browserSnapshot = buildTool({
    name: 'browserSnapshot',
    description:
      'Re-list the interactive elements of the current browser page as refs (@e1 button "Send"). browserNavigate and browserClick already return a fresh snapshot — use this only when the page changed on its own (slow load, redirect, dynamic content). Refs are valid until the next navigation or snapshot — act on the latest snapshot only.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    // Polling by design: re-snapshotting a loading page is identical no-arg
    // input every time — the loop detector's identical-input block would
    // brick it at 5 with impossible "change the input" advice.
    allowsRepeatCalls: true,
    resolveConfirmation: policyAsk('browserSnapshot'),
    timeoutMs: 45_000,
    maxResultSizeChars: 24_000,
    async execute(_input, context) {
      const gate = await gates('browserSnapshot', context)
      if ('error' in gate) return gate.error
      const backend = gate.state.backend
      try {
        const snapshot = await providerFor(backend).snapshot(callCtx(context, gate.state))
        gate.state.refLabels = new Map(snapshot.nodes.map((n) => [n.ref, n.name]))
        const data = renderSnapshot(snapshot) + pageAdvice(context, gate.state, snapshot)
        emit(
          {
            type: 'browser_action',
            op: 'snapshot',
            backend,
            host: hostOf(snapshot.url),
            ok: true,
            ...sized(data),
          },
          context,
        )
        return { data, meta: { backend, nodes: snapshot.nodes.length } }
      } catch (err) {
        emit(
          {
            type: 'browser_action',
            op: 'snapshot',
            backend,
            host: null,
            ok: false,
            code: err instanceof BrowserBackendError ? err.code : undefined,
          },
          context,
        )
        return backendErrorResult(err, backend)
      }
    },
  })

  // ── browserClick (send-gated) ────────────────────────────────

  const browserClick = buildTool({
    name: 'browserClick',
    description:
      'Click an element by its ref from the latest snapshot, and get back a fresh snapshot of the page after the click. Set intent:"submit" when the click sends, posts, buys, deletes, or otherwise commits an outward action — such clicks require user approval before they run. Ordinary clicks (opening a thread, focusing a field) need no approval.',
    inputSchema: z.object({
      ref: z.string().min(1).describe('Element ref from the latest browserSnapshot, e.g. "@e12"'),
      intent: z
        .enum(['activate', 'submit'])
        .optional()
        .describe('"submit" = this click commits an outward action (send/post/buy/delete)'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    // The send gate (spec §3): policy 'ask' gates everything; otherwise a
    // click confirms when the model declared submit intent, when the target's
    // accessible name is send-like, or — fail-closed — when the label is
    // unknown (no snapshot cached this session, e.g. after a process restart).
    resolveConfirmation: async (context, input) => {
      if (await policyAsk('browserClick')(context)) return true
      const parsed = input as { ref?: string; intent?: string } | undefined
      if (parsed?.intent === 'submit') return true
      const label = parsed?.ref ? sessions.get(context.sessionId)?.refLabels.get(parsed.ref) : undefined
      if (label === undefined) return true
      return SEND_LIKE_LABEL_PATTERN.test(label)
    },
    describeConfirmation: async (input, context) => {
      const parsed = input as { ref?: string; intent?: string }
      const state = sessions.get(context.sessionId)
      const label = parsed.ref ? state?.refLabels.get(parsed.ref) : undefined
      const lines = [label ? `Click "${label}" in the browser` : `Click ${parsed.ref ?? 'an element'} in the browser`]
      if (state?.lastTyped) {
        const preview = state.lastTyped.length > 200 ? `${state.lastTyped.slice(0, 200)}…` : state.lastTyped
        lines.push(`Message: ${preview}`)
      }
      lines.push('This looks like a send/submit action, so it runs only if you approve.')
      return lines
    },
    timeoutMs: 90_000,
    maxResultSizeChars: 24_000,
    async execute(input, context) {
      const gate = await gates('browserClick', context)
      if ('error' in gate) return gate.error
      const backend = gate.state.backend
      try {
        await providerFor(backend).click(callCtx(context, gate.state), input.ref)
        emit({ type: 'browser_action', op: 'click', backend, host: null, ok: true }, context)
        const snap = await inlineSnapshot(context, gate.state, backend)
        const advice = snap ? pageAdvice(context, gate.state, snap.snapshot) : ''
        return {
          data:
            `Clicked ${input.ref}.` +
            (snap
              ? ` Page after the click:\n\n${snap.rendered}`
              : ' The page may have changed — take browserSnapshot to see the result.') +
            advice,
          meta: { backend, ...(snap ? { nodes: snap.snapshot.nodes.length } : {}) },
        }
      } catch (err) {
        emit(
          {
            type: 'browser_action',
            op: 'click',
            backend,
            host: null,
            ok: false,
            code: err instanceof BrowserBackendError ? err.code : undefined,
          },
          context,
        )
        return backendErrorResult(err, backend)
      }
    },
  })

  // ── browserType ──────────────────────────────────────────────

  const browserType = buildTool({
    name: 'browserType',
    description:
      'Type text into an element by its ref from the latest browserSnapshot (composing — no approval needed; the send itself is what gets approved).',
    inputSchema: z.object({
      ref: z.string().min(1).describe('Element ref from the latest browserSnapshot'),
      text: z.string().max(20_000).describe('Text to type'),
    }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('browserType'),
    timeoutMs: 45_000,
    async execute(input, context) {
      const gate = await gates('browserType', context)
      if ('error' in gate) return gate.error
      const backend = gate.state.backend
      try {
        await providerFor(backend).type(callCtx(context, gate.state), input.ref, input.text)
        gate.state.lastTyped = input.text
        // No inline snapshot here, so `type` is near-free next to navigate and
        // click. Recording the size is what makes that asymmetry visible.
        const data = `Typed ${input.text.length} characters into ${input.ref}.`
        emit({ type: 'browser_action', op: 'type', backend, host: null, ok: true, ...sized(data) }, context)
        return { data, meta: { backend } }
      } catch (err) {
        emit(
          {
            type: 'browser_action',
            op: 'type',
            backend,
            host: null,
            ok: false,
            code: err instanceof BrowserBackendError ? err.code : undefined,
          },
          context,
        )
        return backendErrorResult(err, backend)
      }
    },
  })

  // ── browserCurrentUrl ────────────────────────────────────────

  const browserCurrentUrl = buildTool({
    name: 'browserCurrentUrl',
    description: 'Get the current URL and title of the controlled browser tab.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    allowsRepeatCalls: true,
    resolveConfirmation: policyAsk('browserCurrentUrl'),
    timeoutMs: 20_000,
    async execute(_input, context) {
      const gate = await gates('browserCurrentUrl', context)
      if ('error' in gate) return gate.error
      const backend = gate.state.backend
      try {
        const res = await providerFor(backend).currentUrl(callCtx(context, gate.state))
        const data = `URL: ${res.url}\nTitle: ${res.title || '(untitled)'}`
        emit(
          {
            type: 'browser_action',
            op: 'currentUrl',
            backend,
            host: hostOf(res.url),
            ok: true,
            ...sized(data),
          },
          context,
        )
        return { data, meta: { backend } }
      } catch (err) {
        emit(
          {
            type: 'browser_action',
            op: 'currentUrl',
            backend,
            host: null,
            ok: false,
            code: err instanceof BrowserBackendError ? err.code : undefined,
          },
          context,
        )
        return backendErrorResult(err, backend)
      }
    },
  })

  // ── browserReadPage (research read-browse, §12 Part 2) ──────
  //
  // The sends-forbidden variant: one atomic navigate + snapshot on the CLOUD
  // backend only, browsing identity-less (this tool never resolves a
  // profile; if the session's sandbox already carries a signed-in state the
  // user built interactively, reads run in it — the tool just never
  // *initiates* an identity). Cloud-only is a hard rule: this tool's caller
  // is a headless research worker, and a headless worker must never drive
  // the user's real Chrome tab through the local extension.
  //
  // Concurrent research workers share the spawning session's sessionId and
  // therefore ONE sandbox browser, so reads serialize through a per-session
  // promise chain — without it, worker B's navigate lands between worker A's
  // navigate and snapshot and A reads B's page.

  const readLocks = new Map<string, Promise<unknown>>()

  function withReadLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = readLocks.get(sessionId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const guard = run.then(
      () => undefined,
      () => undefined,
    )
    readLocks.set(sessionId, guard)
    void guard.then(() => {
      if (readLocks.get(sessionId) === guard) readLocks.delete(sessionId)
    })
    return run
  }

  function renderReadPage(snapshot: BrowserSnapshot): string {
    // Same content as renderSnapshot minus the @ref tokens — the reader has
    // no click/type surface, so refs would only tempt the model to act.
    const lines = snapshot.nodes.slice(0, SNAPSHOT_MAX_LINES).map((n) => {
      const value = n.value ? ` value=${JSON.stringify(n.value)}` : ''
      return `${n.role} ${JSON.stringify(n.name)}${value}`
    })
    const truncated =
      snapshot.nodes.length > SNAPSHOT_MAX_LINES
        ? `\n… ${snapshot.nodes.length - SNAPSHOT_MAX_LINES} more elements (page continues beyond this cap)`
        : ''
    return `Page: ${snapshot.title || '(untitled)'}\nURL: ${snapshot.url}\n${lines.join('\n')}${truncated}`
  }

  const browserReadPage = buildTool({
    name: 'browserReadPage',
    description:
      'Open a URL in the governed cloud browser and return the rendered page as a list of its elements. Read-only: no clicking, typing, signing in, or acting — for that the user must run a normal chat turn. Use when a page needs JavaScript to render or blocks plain HTTP readers. Reads on the same session run one at a time, so read the 1-2 URLs that matter, not every link.',
    inputSchema: z.object({
      url: z.string().min(1).describe('Absolute http(s) URL to read'),
    }),
    isReadOnly: true,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    resolveConfirmation: policyAsk('browserReadPage'),
    timeoutMs: 90_000,
    maxResultSizeChars: 24_000,
    async execute(input, context) {
      const gate = await gates('browserReadPage', context)
      if ('error' in gate) return gate.error
      let parsed: URL
      try {
        parsed = new URL(input.url)
      } catch {
        return { data: `ERROR: "${input.url}" is not a valid absolute URL.`, isError: true }
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { data: 'ERROR: Only http(s) URLs can be opened in the browser.', isError: true }
      }
      if (!cloudAvailable()) {
        return {
          data:
            'ERROR: The governed cloud browser is not configured on this deployment, so pages cannot be read this way. Report the URL itself as the finding, citing the search snippet.',
          isError: true,
        }
      }
      // browserReadPage is cloud-only by construction (§12); the fixed backend
      // lets backendErrorResult apply the same connection-block posture (§5) a
      // hard edge reject gets on the interactive tools.
      const backend: BrowserBackendKind = 'cloud'
      // Identity-less on purpose: no profile resolution, no profileId in the
      // call context — a worker read never initiates a vault injection.
      const ctx: BrowserCallContext = {
        userId: context.userId,
        workspaceId: context.workspaceId ?? '',
        sessionId: context.sessionId,
      }
      return withReadLock(context.sessionId, async (): Promise<ToolResult> => {
        try {
          const res = await opts.cloud.navigate(ctx, input.url)
          // Interactive refs (if any) are stale now — the sandbox page moved.
          gate.state.refLabels.clear()
          if (looksLikeLoginWall(res.url)) {
            // No pause, no Take-Over link: a headless worker cannot wait for
            // a sign-in, and other workers may need the sandbox next. The
            // URL itself is the deliverable — same posture as urlReader's
            // auth-walled short-circuit.
            // Sized like every other returning branch. This one still hands
            // the model ~250 chars, so leaving it unsized under-reports the
            // turn's browser cost — and unlike `navigate`/`click`, no paired
            // `snapshot` event carries the bytes on its behalf.
            const data =
              `This page sits behind a login (${res.url}), and this reader cannot sign in. ` +
              `Report the URL as the finding and note it needs a signed-in session — the user can open it from a normal chat turn, where sign-in is possible. Do not retry this URL.`
            emit(
              {
                type: 'browser_action',
                op: 'readPage',
                backend: 'cloud',
                host: hostOf(res.url),
                ok: true,
                ...sized(data),
              },
              context,
            )
            return { data, meta: { backend: 'cloud', loginWall: true } }
          }
          const snapshot = await opts.cloud.snapshot(ctx)
          // Same posture as the login wall: a headless worker cannot solve a
          // challenge — the URL is the deliverable, never a retry loop.
          const challenge = looksLikeCaptcha(snapshot)
            ? '\n\nNOTE: this page is showing a human-verification challenge (captcha), which this reader cannot solve. Report the URL as the finding and move on — do not retry it.'
            : ''
          const data = renderReadPage(snapshot) + challenge
          emit(
            {
              type: 'browser_action',
              op: 'readPage',
              backend: 'cloud',
              host: hostOf(snapshot.url),
              ok: true,
              ...sized(data),
            },
            context,
          )
          return { data, meta: { backend: 'cloud', nodes: snapshot.nodes.length } }
        } catch (err) {
          emit(
            {
              type: 'browser_action',
              op: 'readPage',
              backend: 'cloud',
              host: hostOf(input.url),
              ok: false,
              code: err instanceof BrowserBackendError ? err.code : undefined,
            },
            context,
          )
          return backendErrorResult(err, backend)
        }
      })
    },
  })

  return {
    browserNavigate,
    browserSnapshot,
    browserClick,
    browserType,
    browserCurrentUrl,
    browserReadPage,
    setSessionBackendOverride(sessionId, backend) {
      const state = sessions.get(sessionId)
      if (state) {
        state.backendOverride = backend
        if (backend) state.backend = backend === 'cloud' && !cloudAvailable() ? 'local' : backend
      } else if (backend) {
        sessions.set(sessionId, {
          backend: backend === 'cloud' && !cloudAvailable() ? 'local' : backend,
          backendOverride: backend,
          profileId: null,
          profileName: null,
          refLabels: new Map(),
          lastTyped: null,
          calls: 0,
          firstCallAt: now(),
          lastCallAt: now(),
          captchaHits: 0,
          takeoverAnnounced: false,
        })
      }
    },
    getSessionBackend(sessionId) {
      return sessions.get(sessionId)?.backend ?? null
    },
  }
}
