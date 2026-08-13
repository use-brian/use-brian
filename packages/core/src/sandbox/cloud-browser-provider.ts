/**
 * Cloud browsing backend (§4.11): the E2B sandbox's agent-browser, reached
 * through the `SandboxProvider` seam. Stateless-orchestrator discipline:
 * every op resolves the task's sandbox and `connect`s by id — this module
 * never holds a live browser between calls (spec §5).
 */
import type {
  BrowserCallContext,
  BrowserProvider,
  SandboxBrowser,
  SandboxProvider,
} from './types.js'
import { BrowserBackendError } from './types.js'

/**
 * Resolves the active cloud sandbox task for a chat session — creating one
 * (with pre-flight budget authorization, §6) when none exists. Owned by the
 * orchestrator; injected so this provider stays a thin adapter. The `url`
 * hint lets task creation pick the vault bundle to re-inject (§4.4) and is
 * required to start a new browser — target-less ops may only reuse one;
 * `onNavigated` feeds the silent-death probe (§6).
 */
export type SandboxTaskBinding = {
  resolve(ctx: BrowserCallContext, hint?: { url?: string; browser?: boolean }): Promise<{ sandboxId: string }>
  onNavigated?(ctx: BrowserCallContext, url: string): Promise<void>
  /**
   * Host-owned one-shot recovery hook. It may retire the current task and
   * install a fresh profile session; true asks this adapter to resolve a new
   * sandbox and retry the ORIGINAL URL once. It is never exposed as a model
   * tool and is intentionally absent from the bare orchestrator binding used
   * by the auth broker itself.
   */
  recoverLogin?(
    ctx: BrowserCallContext,
    navigation: { requestedUrl: string; currentUrl: string },
  ): Promise<{
    retry: boolean
    /** Host-owned postcondition check, called once with the retried URL. */
    afterRetry?(currentUrl: string): Promise<void>
  }>
}

export function createCloudBrowserProvider(deps: {
  provider: SandboxProvider | null
  binding: SandboxTaskBinding | null
}): BrowserProvider {
  async function browserFor(ctx: BrowserCallContext, hint?: { url?: string }): Promise<SandboxBrowser> {
    if (!deps.provider || !deps.binding) {
      throw new BrowserBackendError(
        'Cloud browsing is not configured on this deployment (no sandbox provider).',
        'not_configured',
      )
    }
    const { sandboxId } = await deps.binding.resolve(ctx, { ...hint, browser: true })
    await deps.provider.connect(sandboxId)
    return deps.provider.browser(sandboxId)
  }

  return {
    kind: 'cloud',
    async navigate(ctx, url) {
      let result = await (await browserFor(ctx, { url })).navigate(url)
      await deps.binding?.onNavigated?.(ctx, result.url)
      // One bounded retry only. The recovery hook runs host-side, and when it
      // succeeds it has retired this login-walled task and vaulted a session
      // from a separate auth sandbox. Resolving again therefore creates a
      // fresh assistant sandbox that receives the session bundle, never the
      // credential.
      const recovery = deps.binding?.recoverLogin
        ? await deps.binding.recoverLogin(ctx, { requestedUrl: url, currentUrl: result.url })
        : null
      if (recovery?.retry) {
        result = await (await browserFor(ctx, { url })).navigate(url)
        await deps.binding?.onNavigated?.(ctx, result.url)
        await recovery.afterRetry?.(result.url)
      }
      return result
    },
    async snapshot(ctx, options) {
      return (await browserFor(ctx)).snapshot(options)
    },
    async click(ctx, ref) {
      await (await browserFor(ctx)).click(ref)
    },
    async type(ctx, ref, text) {
      await (await browserFor(ctx)).type(ref, text)
    },
    async currentUrl(ctx) {
      return (await browserFor(ctx)).currentUrl()
    },
    async captureState(ctx, site) {
      return (await browserFor(ctx)).captureStorageState(site)
    },
    async stop() {
      // Task teardown (pause/kill) is the lifecycle module's job, not the
      // per-op adapter's — see sandbox/lifecycle. Nothing to release here.
    },
  }
}
