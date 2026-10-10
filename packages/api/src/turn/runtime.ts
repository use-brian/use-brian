/**
 * The turn kernel's deployment-wide inference wiring, registered ONCE at boot
 * (unified-sessions section 4.3, stage 5).
 *
 * Two facts decide which model serves a turn: the workspace custom endpoint
 * resolver (`resolveWorkspaceCustomLlm`) and the deployment's configured
 * providers (`configuredProviders`). Both used to be threaded by hand through
 * every route into every runner, optional at each layer, so a route that
 * forgot them silently ran a workspace on platform inference (2026-08-19: the
 * hosted Telegram bot). Boot now registers them here; every runner resolves
 * through `turnInference(...)`, which prefers an explicitly threaded value and
 * otherwise reads the registration. A forgotten hand-off can no longer
 * change which model answers.
 *
 * Graded by `pnpm check` (`invariants/channel-custom-llm-wiring`).
 *
 * [COMP:api/turn-kernel]
 */
import type { ProviderAvailability } from '@use-brian/shared/model-registry'
import type { WorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'

export type TurnKernelRuntime = {
  resolveWorkspaceCustomLlm: WorkspaceCustomLlmResolver | null
  configuredProviders: ProviderAvailability | undefined
}

let registered: TurnKernelRuntime | null = null

/** Boot registers the deployment's inference wiring. Called once per process. */
export function configureTurnKernel(runtime: TurnKernelRuntime): void {
  registered = runtime
}

/** Test seam: forget the registration. */
export function resetTurnKernelForTests(): void {
  registered = null
}

/**
 * The inference wiring for one turn: an explicitly threaded value wins (tests,
 * a runner with a narrower resolver), otherwise the boot registration.
 */
export function turnInference(explicit: {
  resolveWorkspaceCustomLlm?: WorkspaceCustomLlmResolver | null
  configuredProviders?: ProviderAvailability
} = {}): TurnKernelRuntime {
  return {
    resolveWorkspaceCustomLlm: explicit.resolveWorkspaceCustomLlm ?? registered?.resolveWorkspaceCustomLlm ?? null,
    configuredProviders: explicit.configuredProviders ?? registered?.configuredProviders,
  }
}

/**
 * A runner's options with the two inference fields resolved through
 * `turnInference` (explicit value first, boot registration second). Applied
 * per turn, so a route constructed before boot registered still sees it.
 */
export function withTurnInference<T extends {
  resolveWorkspaceCustomLlm?: WorkspaceCustomLlmResolver | null
  configuredProviders?: ProviderAvailability
}>(options: T): T {
  const inference = turnInference(options)
  return {
    ...options,
    resolveWorkspaceCustomLlm: inference.resolveWorkspaceCustomLlm ?? options.resolveWorkspaceCustomLlm,
    configuredProviders: inference.configuredProviders,
  }
}
