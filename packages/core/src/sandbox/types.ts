/**
 * Computer-use provider seams — the two interfaces everything else programs
 * against. Spec: docs/architecture/engine/computer-use.md (§1 "Seams").
 *
 * Barrier 1 of the build order: these seams land before any feature code.
 *
 *  - `BrowserProvider` — the discrete browsing surface. Two backends:
 *    the user's own Chrome via the extension relay (local) and an E2B
 *    sandbox running agent-browser (cloud). Same surface either way, so
 *    the tool layer is backend-blind.
 *  - `SandboxProvider` — the cloud sandbox lifecycle + compute surface.
 *    ONLY `providers/e2b/` may import the E2B SDK (graded invariant
 *    `sandbox-provider-seam`); swapping impls is a config change.
 */
import { z } from 'zod'

// ── Browser snapshot ───────────────────────────────────────────

/**
 * One interactive node of a ref-based accessibility snapshot
 * (`@e1 button "Send"`). Refs are stable within a single snapshot only —
 * the executor side (extension / agent-browser) rejects stale refs.
 */
export const BrowserSnapshotNodeSchema = z.object({
  ref: z.string().min(1),
  role: z.string(),
  name: z.string(),
  value: z.string().optional(),
  disabled: z.boolean().optional(),
})
export type BrowserSnapshotNode = z.infer<typeof BrowserSnapshotNodeSchema>

export const BrowserSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  nodes: z.array(BrowserSnapshotNodeSchema),
})
export type BrowserSnapshot = z.infer<typeof BrowserSnapshotSchema>

export const BrowserNavigateResultSchema = z.object({ url: z.string() })
export type BrowserNavigateResult = z.infer<typeof BrowserNavigateResultSchema>

export const BrowserUrlResultSchema = z.object({ url: z.string(), title: z.string().default('') })
export type BrowserUrlResult = z.infer<typeof BrowserUrlResultSchema>

// ── Call context ───────────────────────────────────────────────

/** Identity a browser op executes under. Derived from ToolContext — never from model input. */
export type BrowserCallContext = {
  userId: string
  workspaceId: string
  sessionId: string
  /** Active cloud task id, when one exists (cloud mode binding key). */
  taskId?: string
  /**
   * The browser profile the call browses as (R2-4/R2-10) — resolved at call
   * time by the tool layer (`resolveProfileForCall`), never taken raw from
   * model input. Absent → an identity-less browse (no vault injection).
   */
  profileId?: string
}

// ── Errors ─────────────────────────────────────────────────────

export type BrowserBackendErrorCode =
  | 'no_extension'   // no paired extension connection at the relay
  | 'not_configured' // backend has no transport/provider wired (open-core boot without relay/E2B)
  | 'timeout'        // the extension/sandbox did not answer in time
  | 'stopped'        // the user hit Stop in the extension
  | 'tab_closed'     // the controlled tab went away
  | 'detached'       // Chrome ended the CDP session (banner cancelled, DevTools, crash)
  | 'consent_denied' // the user declined the extension's per-tab Allow prompt
  | 'no_eligible_tab' // the active tab is one Chrome will not attach the debugger to
  | 'stale_ref'      // ref is not from the latest snapshot
  | 'backend_error'  // anything else the backend reported

export class BrowserBackendError extends Error {
  constructor(
    message: string,
    readonly code: BrowserBackendErrorCode,
  ) {
    super(message)
    this.name = 'BrowserBackendError'
  }
}

/**
 * What to DO about a missing extension. Kept separate from the cause so a
 * relay that knows more (disconnected, or evicted by a newer pairing) can say
 * so and still carry the instruction — the P1.4 contract is a clear next step,
 * never a hang, and that does not require discarding the reason.
 */
export const NO_EXTENSION_REMEDY =
  'Ask the user to open Chrome with the Use Brian extension installed and enabled (and signed in), then retry.'

/** The P1.4 contract: a missing extension is a clear instruction, never a hang. */
export const NO_EXTENSION_MESSAGE = `No Use Brian browser extension is connected. ${NO_EXTENSION_REMEDY}`

// ── BrowserProvider seam (§4.15) ───────────────────────────────

/**
 * The flat, discrete browsing surface the computer tools call. Stateless per
 * op: local mode routes by `ctx.userId` (the extension owns the tab binding),
 * cloud mode resolves the task's sandbox per call (stateless orchestrator).
 */
export interface BrowserProvider {
  readonly kind: 'local' | 'cloud'
  navigate(ctx: BrowserCallContext, url: string): Promise<BrowserNavigateResult>
  snapshot(ctx: BrowserCallContext): Promise<BrowserSnapshot>
  click(ctx: BrowserCallContext, ref: string): Promise<void>
  type(ctx: BrowserCallContext, ref: string, text: string): Promise<void>
  currentUrl(ctx: BrowserCallContext): Promise<BrowserUrlResult>
  /** Best-effort release of the task's browsing binding (close-to-stop is user-side). */
  stop(ctx: BrowserCallContext): Promise<void>
}

// ── Relay transport port (local mode) ──────────────────────────

/**
 * Wire-level result of one relay command (`command{id,op,args}` →
 * `result{id,ok,data|error}`; spec §4 "Local mode"). The api implements this
 * port with an HTTP POST to the relay's `/internal/browser/command`; tests
 * implement it in memory.
 */
export type RelayCommandResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; code?: string }

export type RelayCommandTransport = {
  send(params: {
    userId: string
    op: string
    args?: Record<string, unknown>
  }): Promise<RelayCommandResult>
}

// ── Session bundles + vault port (§4.4) ────────────────────────

/**
 * A captured authenticated browser session for one site: cookies +
 * localStorage (`storageState` shape), never a password. Encrypted at rest
 * by the closed vault store; this type is the plaintext the provider
 * injects/captures inside a live sandbox.
 */
export type SessionBundle = {
  /** Registrable domain the bundle authenticates (e.g. `github.com`). */
  site: string
  /** Opaque storageState cookies array (Playwright/CDP shape). */
  cookies: unknown[]
  /** origin → key → value. */
  localStorage?: Record<string, Record<string, string>>
  capturedAt: string
}

export type VaultSessionInfo = {
  site: string
  capturedAt: string
  lastUsedAt: string | null
  status: 'active' | 'dead'
}

/**
 * The session-vault port — sessions are CHILDREN of a browser profile
 * (R2-4/R2-6): every bundle is scoped per (profile, site), one login per
 * site per identity. The impl is closed (platform — envelope-encrypted
 * Postgres rows whose RLS derives from the profile's clearance rung);
 * open-core boots without it and cloud session reuse is simply unavailable.
 * The browsing agent has NO tool over this interface — only the orchestrator
 * and the Profile-Management routes call it.
 */
export interface SessionVault {
  get(params: { profileId: string; site: string }): Promise<SessionBundle | null>
  put(params: { profileId: string; site: string; bundle: SessionBundle }): Promise<void>
  /** Silent-death probe outcome: bundle no longer logs in. Kept for re-auth UX. */
  markDead(params: { profileId: string; site: string }): Promise<void>
  touch(params: { profileId: string; site: string }): Promise<void>
  list(params: { profileId: string }): Promise<VaultSessionInfo[]>
  revoke(params: { profileId: string; site: string }): Promise<void>
  /**
   * Per-plan inactivity purge (§4.10: ~30 d free / 90 d paid). Optional —
   * the closed impl derives the cutoff from the workspace plan; the reaper
   * runs it daily. Returns the number of purged bundles.
   */
  purgeInactive?(): Promise<number>
}

// ── Take-Over surface (§4.8) ───────────────────────────────────

export type TakeoverInputEvent =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'key'; text: string }
  | { kind: 'scroll'; deltaY: number }
  /**
   * Browser-chrome navigation from the take-over toolbar (§5). `goto` carries a
   * validated http(s) `url`; back/forward/reload need none. Dispatched via CDP
   * `Page.*` on both the stream bridge and the per-event helper (kept in lockstep).
   */
  | { kind: 'navigate'; action: 'back' | 'forward' | 'reload' | 'goto'; url?: string }

export type TakeoverFrame = { data: string; mimeType: string }

export type SandboxTakeover = {
  /** Next screencast frame (base64 image), or null once the stream closes. */
  nextFrame(): Promise<TakeoverFrame | null>
  input(event: TakeoverInputEvent): Promise<void>
  close(): Promise<void>
}

// ── SandboxProvider seam (§4.3) ────────────────────────────────

export type SandboxCreateOptions = {
  workspaceId: string
  taskId: string
  /** Region hint — match the sandbox to the user's geography (§4.6). */
  region?: string
  /**
   * Dormant BYOP proxy hook (§4.6): forwarded to agent-browser's `-p`
   * provider flag when set. Demand-triggered per site — never a pool.
   */
  proxyUrl?: string
  /**
   * Non-browser egress allowlist — deny-by-default (§8). The browser process
   * is exempt (it must reach the target site); Python is always denied
   * regardless of this list.
   */
  egressAllowlist?: string[]
  /** Reaper backstop: hard max sandbox lifetime. */
  maxLifetimeSeconds?: number
}

export type SandboxHandle = { sandboxId: string }

export type RunPythonRequest = { code: string; timeoutMs?: number }
export type RunPythonResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/** A running logic-block (R2-9). The host gate loop runs while it executes. */
export type BlockRunHandle = {
  wait(): Promise<RunPythonResult>
}

/** One step of a browser-use exploration trace (R2-1/R2-5 — self-heal input). */
export type BuTraceStep = {
  step: number
  action: 'open' | 'click' | 'fill' | 'scroll' | 'extract' | 'done'
  url?: string | null
  /** Accessible label / selector text of the acted-on element. */
  label?: string | null
  /** Text typed (fill) or extracted (extract). */
  text?: string | null
  detail?: string | null
}

export type BrowserUseRunResult = {
  trace: BuTraceStep[]
  /** The agent's final answer / summary text. */
  output: string
}

/**
 * The file-bridge's provider half: byte movement between Use Brian and the
 * sandbox's ephemeral scratch. Workspace scoping lives ABOVE this seam (the
 * tools resolve files through `FilesApi` with the ToolContext's workspace) —
 * the provider only ever sees bytes and scratch paths.
 */
export type SandboxBridge = {
  load(sandboxId: string, params: { path: string; bytes: Uint8Array }): Promise<{ path: string }>
  save(sandboxId: string, params: { path: string }): Promise<{ bytes: Uint8Array }>
  /** Browser downloads accumulated in the scratch downloads dir (auto-pull at task end). */
  pullDownloads(sandboxId: string): Promise<Array<{ path: string; bytes: Uint8Array }>>
}

/**
 * Live take-over stream endpoints (capability URLs — the token IS the auth;
 * minted per sandbox, dies with it). Frames = SSE of screencast JPEG events;
 * input = per-event POST. Both point straight at the sandbox's public host,
 * never through the API.
 */
export type TakeoverStreamInfo = {
  framesUrl: string
  inputUrl: string
  /** Duplex WebSocket (binary frames down, JSON input up). Absent on backends that only speak SSE. */
  wsUrl?: string
}

/** The per-sandbox discrete browser surface (agent-browser glue lives behind it). */
export type SandboxBrowser = {
  navigate(url: string): Promise<BrowserNavigateResult>
  snapshot(): Promise<BrowserSnapshot>
  click(ref: string): Promise<void>
  type(ref: string, text: string): Promise<void>
  currentUrl(): Promise<BrowserUrlResult>
  captureStorageState(site: string): Promise<SessionBundle>
  injectStorageState(bundle: SessionBundle): Promise<void>
  takeover(): SandboxTakeover
  /**
   * Start (or reuse) the live take-over stream for this sandbox and return
   * its capability URLs. Absent/null on backends without streaming — the
   * caller falls back to the polled frame + per-event input routes.
   */
  openTakeoverStream?(): Promise<TakeoverStreamInfo | null>
}

/**
 * The sandbox backend seam (§4.3). v1 impl: `E2BCloudProvider`
 * (`providers/e2b/` — the ONLY module allowed to import the E2B SDK).
 * `StubSandboxProvider` (`providers/stub.ts`) proves a swap needs no
 * orchestrator change. Future: `E2BByocProvider` / `SelfHostProvider`.
 */
export interface SandboxProvider {
  readonly name: string
  create(opts: SandboxCreateOptions): Promise<SandboxHandle>
  connect(sandboxId: string): Promise<SandboxHandle>
  pause(sandboxId: string): Promise<void>
  resume(sandboxId: string): Promise<void>
  kill(sandboxId: string): Promise<void>
  browser(sandboxId: string): SandboxBrowser
  /**
   * Isolated Python compute (§4.7): egress-denied, no browser handle, no
   * tool access, scratch-only. Contained by construction in every impl.
   * This is the ISOLATED lane — a logic-block never runs here (R2-9).
   */
  runPython(sandboxId: string, req: RunPythonRequest): Promise<RunPythonResult>
  /**
   * The PRIVILEGED block-runner lane (R2-9): starts a reviewed logic-block's
   * entry script (materialized into scratch by the skill-runner, next to the
   * governed shim). Unlike `runPython` it may drive the browser — through
   * the shim's verbs only; its terminal sends still handshake with the
   * host-side gate. Browser access is EARNED by the R2-5 authoring gate,
   * never open to arbitrary code.
   */
  runSkill(sandboxId: string, req: { entryPath: string; timeoutMs?: number }): Promise<BlockRunHandle>
  /**
   * The WATCHED agentic fallback (R2-1/R2-7): run browser-use inside the
   * cloud micro-VM for a novel flow and return its step trace, which the
   * self-heal distiller compiles into a draft logic-block. Cloud-only by
   * construction — the local backend has no such method, and the tool layer
   * refuses unattended local runs outright.
   */
  runBrowserUse(
    sandboxId: string,
    req: { goal: string; maxSteps?: number; timeoutMs?: number },
  ): Promise<BrowserUseRunResult>
  bridge: SandboxBridge
}
