/**
 * Per-turn extra-tool injection PORT — the generic seam a route builder exposes
 * so a host platform can merge additional tools into a turn's tool map for
 * certain assistants. The open route knows only that the host *may* inject extra
 * tools; it does not know what they are or which assistants get them. The closed
 * platform wires an impl that gates on `assistant.kind`/`appType` and merges its
 * tools (e.g. a distribution app's publishing tools). Open default: unset — no
 * extra tools. See the open-core split (repo CLAUDE.md; plan in git history) §12.5.
 */

import type { Tool } from '@use-brian/core'

export interface ExtraToolContext {
  /** The turn's tool map. The injector mutates it in place. */
  tools: Map<string, Tool>
  userId: string
  assistant: {
    id: string
    kind: 'standard' | 'app' | 'primary'
    appType: string | null
  }
  /**
   * The turn's session, when there is one (the live chat route). Absent for an
   * inter-assistant callee consult, which has no user session — a host injector
   * that keys off session state must tolerate `undefined`.
   */
  session?: {
    id: string
    /** Session mode (e.g. a host may key tool choice off a 'draft' mode). */
    mode: string | null
    channelType: string
  }
  /**
   * Opaque per-turn connector-action audit deps, shared with the MCP inject.
   * The open route forwards it without inspecting it; a host injector that emits
   * connector actions casts it to its own deps type.
   */
  connectorActionAudit?: unknown
}

/** Inject extra tools for a turn. Composition root wires the host impl; open = unset. */
export type InjectExtraTools = (ctx: ExtraToolContext) => Promise<void>

/**
 * Build the Layer-1 system prompt ("soul") for a `kind='app'` assistant — a host
 * seam so the open prompt builder does not hard-code any app type. Returns the
 * soul string, or `null` to fall back to the default prompt. The open default is
 * unset (app assistants fall back to the default prompt). The composition root
 * wires an impl (e.g. a distribution app's publishing soul).
 */
export type ResolveAppSoul = (params: {
  /** The app assistant's type (e.g. a host may build a distinct soul per type). */
  appType: string | null
  name: string
  team?: { name: string; purpose?: string | null } | null
  assistantBio?: string | null
  /** Opaque host-defined prompt mode (e.g. interactive vs publishing). */
  mode?: string
}) => string | null
