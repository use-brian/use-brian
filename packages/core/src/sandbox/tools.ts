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
import { looksLikeLoginWall, registrableSiteOf } from './orchestrator.js'
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

export const DEFAULT_FUSE_MAX_CALLS = 40
export const DEFAULT_FUSE_MAX_WALL_MS = 15 * 60 * 1000

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
  fuse?: { maxCallsPerSession?: number; maxWallMsPerSession?: number }
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

  /** P1.8 safety fuse: hard per-session call + wall-clock caps. */
  function fuseGate(state: SessionBrowseState): ToolResult | null {
    if (state.calls >= maxCalls) {
      return {
        data: `ERROR: This session hit the browser-action safety cap (${maxCalls} calls). Summarize progress and ask the user before continuing.`,
        isError: true,
      }
    }
    if (now() - state.firstCallAt > maxWallMs) {
      return {
        data: `ERROR: This session's browser task hit the wall-clock safety cap (${Math.round(maxWallMs / 60000)} minutes). Summarize progress and ask the user before continuing.`,
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
    return { state }
  }

  function backendErrorResult(err: unknown): ToolResult {
    if (err instanceof BrowserBackendError) {
      return { data: `ERROR: ${err.message}`, isError: true, meta: { code: err.code } }
    }
    return {
      data: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
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

  // ── browserNavigate ──────────────────────────────────────────

  const browserNavigate = buildTool({
    name: 'browserNavigate',
    description:
      'Open a URL in the controlled browser. Browsing runs as a browser profile (a saved login identity) when one is enabled for you — pass "profile" to pick one by name when several match. Always take browserSnapshot after navigating — refs from before a navigation are stale.',
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
    timeoutMs: 45_000,
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
        return {
          data:
            `Opened ${res.url} (${backend} browser). Take browserSnapshot to see the page.` +
            (liveLink
              ? ` The user can watch this browser live and take over (e.g. to sign in) at: ${liveLink} — share that link whenever they ask to watch, sign in, or take over.`
              : ''),
          meta: { backend, ...(liveLink ? { takeoverUrl: liveLink } : {}) },
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
        return backendErrorResult(err)
      }
    },
  })

  // ── browserSnapshot ──────────────────────────────────────────

  const browserSnapshot = buildTool({
    name: 'browserSnapshot',
    description:
      'List the interactive elements of the current browser page as refs (@e1 button "Send"). Refs are valid until the next navigation or snapshot — act on the latest snapshot only.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: false,
    requiresConfirmation: false,
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
        emit({ type: 'browser_action', op: 'snapshot', backend, host: hostOf(snapshot.url), ok: true }, context)
        return { data: renderSnapshot(snapshot), meta: { backend, nodes: snapshot.nodes.length } }
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
        return backendErrorResult(err)
      }
    },
  })

  // ── browserClick (send-gated) ────────────────────────────────

  const browserClick = buildTool({
    name: 'browserClick',
    description:
      'Click an element by its ref from the latest browserSnapshot. Set intent:"submit" when the click sends, posts, buys, deletes, or otherwise commits an outward action — such clicks require user approval before they run. Ordinary clicks (opening a thread, focusing a field) need no approval.',
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
    timeoutMs: 45_000,
    async execute(input, context) {
      const gate = await gates('browserClick', context)
      if ('error' in gate) return gate.error
      const backend = gate.state.backend
      try {
        await providerFor(backend).click(callCtx(context, gate.state), input.ref)
        emit({ type: 'browser_action', op: 'click', backend, host: null, ok: true }, context)
        return {
          data: `Clicked ${input.ref}. The page may have changed — take browserSnapshot to see the result.`,
          meta: { backend },
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
        return backendErrorResult(err)
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
        emit({ type: 'browser_action', op: 'type', backend, host: null, ok: true }, context)
        return { data: `Typed ${input.text.length} characters into ${input.ref}.`, meta: { backend } }
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
        return backendErrorResult(err)
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
    resolveConfirmation: policyAsk('browserCurrentUrl'),
    timeoutMs: 20_000,
    async execute(_input, context) {
      const gate = await gates('browserCurrentUrl', context)
      if ('error' in gate) return gate.error
      const backend = gate.state.backend
      try {
        const res = await providerFor(backend).currentUrl(callCtx(context, gate.state))
        emit({ type: 'browser_action', op: 'currentUrl', backend, host: hostOf(res.url), ok: true }, context)
        return { data: `URL: ${res.url}\nTitle: ${res.title || '(untitled)'}`, meta: { backend } }
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
        return backendErrorResult(err)
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
            emit({ type: 'browser_action', op: 'readPage', backend: 'cloud', host: hostOf(res.url), ok: true }, context)
            return {
              data:
                `This page sits behind a login (${res.url}), and this reader cannot sign in. ` +
                `Report the URL as the finding and note it needs a signed-in session — the user can open it from a normal chat turn, where sign-in is possible. Do not retry this URL.`,
              meta: { backend: 'cloud', loginWall: true },
            }
          }
          const snapshot = await opts.cloud.snapshot(ctx)
          emit({ type: 'browser_action', op: 'readPage', backend: 'cloud', host: hostOf(snapshot.url), ok: true }, context)
          return { data: renderReadPage(snapshot), meta: { backend: 'cloud', nodes: snapshot.nodes.length } }
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
          return backendErrorResult(err)
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
        })
      }
    },
    getSessionBackend(sessionId) {
      return sessions.get(sessionId)?.backend ?? null
    },
  }
}
