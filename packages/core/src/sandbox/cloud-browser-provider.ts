import type { CurrentAuthorityBoundary } from '../tools/types.js'
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
  resolve(ctx: BrowserCallContext, hint?: { url?: string; browser?: boolean }): Promise<{ sandboxId: string; authority?: CurrentAuthorityBoundary }>
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
  async function browserFor(ctx: BrowserCallContext, hint?: { url?: string }): Promise<{ browser: SandboxBrowser; authority?: CurrentAuthorityBoundary }> {
    if (!deps.provider || !deps.binding) {
      throw new BrowserBackendError(
        'Cloud browsing is not configured on this deployment (no sandbox provider).',
        'not_configured',
      )
    }
    const { sandboxId, authority } = await deps.binding.resolve(ctx, { ...hint, browser: true })
    await ctx.authority?.assertCurrent()
    await authority?.assertCurrent()
    await deps.provider.connect(sandboxId)
    await ctx.authority?.assertCurrent()
    await authority?.assertCurrent()
    return { browser: deps.provider.browser(sandboxId), authority }
  }

  async function withBrowser<T>(ctx: BrowserCallContext, hint: { url?: string } | undefined, operation: (browser: SandboxBrowser) => Promise<T>): Promise<T> {
    const resolved = await browserFor(ctx, hint)
    return resolved.authority ? resolved.authority.execute(() => operation(resolved.browser)) : operation(resolved.browser)
  }

  async function run<T>(ctx: BrowserCallContext, operation: () => Promise<T>): Promise<T> {
    return ctx.authority ? ctx.authority.execute(operation) : operation()
  }

  return {
    kind: 'cloud',
    async navigate(ctx, url) {
      return run(ctx, async () => {
        let result = await withBrowser(ctx, { url }, browser => browser.navigate(url))
        await ctx.authority?.assertCurrent()
        await deps.binding?.onNavigated?.(ctx, result.url)
        await ctx.authority?.assertCurrent()
        // One bounded retry only. The recovery hook runs host-side, and when it
        // succeeds it has retired this login-walled task and vaulted a session
        // from a separate auth sandbox. Resolving again therefore creates a
        // fresh assistant sandbox that receives the session bundle, never the
        // credential.
        const recovery = deps.binding?.recoverLogin
          ? await deps.binding.recoverLogin(ctx, { requestedUrl: url, currentUrl: result.url })
          : null
        await ctx.authority?.assertCurrent()
        if (recovery?.retry) {
          result = await withBrowser(ctx, { url }, browser => browser.navigate(url))
          await ctx.authority?.assertCurrent()
          await deps.binding?.onNavigated?.(ctx, result.url)
          await ctx.authority?.assertCurrent()
          await recovery.afterRetry?.(result.url)
        }
        return result
      })
    },
    async snapshot(ctx, options) {
      return run(ctx, async () => withBrowser(ctx, undefined, browser => browser.snapshot(options)))
    },
    async click(ctx, ref) {
      await run(ctx, async () => withBrowser(ctx, undefined, browser => browser.click(ref)))
    },
    async type(ctx, ref, text) {
      await run(ctx, async () => withBrowser(ctx, undefined, browser => browser.type(ref, text)))
    },
    async currentUrl(ctx) {
      return run(ctx, async () => withBrowser(ctx, undefined, browser => browser.currentUrl()))
    },
    async captureState(ctx, site) {
      return run(ctx, async () => withBrowser(ctx, undefined, browser => browser.captureStorageState(site)))
    },
    async stop() {
      // Task teardown (pause/kill) is the lifecycle module's job, not the
      // per-op adapter's — see sandbox/lifecycle. Nothing to release here.
    },
  }
}
