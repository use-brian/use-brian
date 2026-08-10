/**
 * The Shopify built-in app's data path.
 *
 * Shopify is a NATIVE operator app (`/w/:workspaceId/shopify`), not a sandboxed
 * bundle, so it has no bridge token and no manifest consent. It still must not
 * be a second way into the store.
 *
 * So this route executes tools, it does not decide them. The callable set comes
 * from `createStoreToolResolver` - the same resolver the sandboxed Home-app
 * bridge uses - which already composes the four filters:
 *
 *   workspace exposure  ∩  connector action grants  ∩  tier  ∩  NOT destructive
 *
 * **The resolver's list IS the allowlist.** A tool name it did not return is a
 * 404 here, so there is no branch in this file that can widen reach. That is
 * deliberate and load-bearing: a per-resource REST surface would have had to
 * re-check exposure and grants itself, and the two connector-scoping incidents
 * this codebase carries (2026-06-01, 2026-07-14) are exactly what happens when
 * that check exists in two places and one of them is wrong.
 *
 * The destructive four are unreachable for the same reason they are unreachable
 * from a bundle: `store-tools.ts` excludes them by construction at every tier.
 * Their safety model is the chat Approve/Deny card, and a page cannot render
 * one any more than an iframe could.
 *
 * [COMP:api/apps-shopify-route]
 */

import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import type { Tool } from '@use-brian/core'
import type { AppStoreScope } from '@use-brian/brian-app'
import { makeBrainContextResolver } from '../brain-mcp/tools.js'
import { baseToolName } from '../mcp/inject.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'

/**
 * The tier this surface runs at.
 *
 * Fixed in code rather than read from a consent row, because a built-in app has
 * no consent row to read - that is the whole difference from a custom app. It
 * is NOT a widening: everything below it (exposure, per-action grants,
 * destructive exclusion) still applies, so a workspace that granted the
 * assistant only reads still gets only reads here.
 */
const STORE_SCOPE: AppStoreScope = 'write'

export type AppsShopifyRouteOptions = {
  requireAuth: RequestHandler
  /** The shared resolver. Same instance the brain-MCP bridge is given. */
  storeTools: (params: { workspaceId: string; storeScope: AppStoreScope }) => Promise<Tool[]>
  /** Hand a task to the workspace assistant, capped at this surface's own tools. */
  askAssistant: (params: { workspaceId: string; storeScope: AppStoreScope; task: string }) => Promise<string>
}

const callBody = z.object({
  workspaceId: z.string().uuid(),
  tool: z.string().min(1).max(200),
  args: z.record(z.unknown()).default({}),
})

const askBody = z.object({
  workspaceId: z.string().uuid(),
  task: z.string().min(1).max(8000),
})

export function appsShopifyRoutes(opts: AppsShopifyRouteOptions): Router {
  const router = Router()

  /**
   * Authenticated AND a member of the workspace named in the request.
   *
   * Naming a workspace is not belonging to it: without the second half, any
   * logged-in user could read any workspace's store by changing one field.
   * Member-gated rather than admin-gated, matching the Home-app session route -
   * the store data this returns is what the workspace's assistant would answer
   * with anyway.
   */
  async function guard(
    req: { userId?: string },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    workspaceId: string,
  ): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const membership = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return null
    }
    return userId
  }

  /**
   * The tools this workspace may reach, as names. Also the shape the UI needs
   * to decide what to render: a page that hides a control it cannot use beats
   * one that offers it and fails.
   */
  router.get('/tools', opts.requireAuth, async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? '')
    if (!z.string().uuid().safeParse(workspaceId).success) {
      res.status(400).json({ error: 'workspaceId must be a uuid' })
      return
    }
    if (!(await guard(req as { userId?: string }, res, workspaceId))) return

    try {
      const tools = await opts.storeTools({ workspaceId, storeScope: STORE_SCOPE })
      // Zero is a real answer, not an error: it means the store connector is
      // not exposed to this workspace. The page says so rather than looking
      // broken, because that is a thing the owner can fix in Studio.
      res.json({ tools: tools.map((t) => baseToolName(t.name)), connected: tools.length > 0 })
    } catch (err) {
      res.status(502).json({ error: 'store_unreachable', detail: message(err) })
    }
  })

  router.post('/call', opts.requireAuth, async (req, res) => {
    const parsed = callBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.message })
      return
    }
    const { workspaceId, tool, args } = parsed.data
    if (!(await guard(req as { userId?: string }, res, workspaceId))) return

    let tools: Tool[]
    try {
      tools = await opts.storeTools({ workspaceId, storeScope: STORE_SCOPE })
    } catch (err) {
      res.status(502).json({ error: 'store_unreachable', detail: message(err) })
      return
    }

    // ZERO tools is a different fact from "not that one", and conflating them
    // sends people hunting for a missing grant when the store connection has
    // simply expired. Seen live: an expired token 401s, the health probe flips
    // the instance to `auth_failed`, the resolver then returns nothing, and
    // every tool reads as "not available" - which names no remedy at all.
    //
    // It leaks nothing: an empty set says only that no store is reachable,
    // never which tools exist or which are merely ungranted.
    if (!tools.length) {
      res.status(409).json({ error: 'store_unavailable' })
      return
    }

    // Match on the canonical name so a multi-store instance (`name__label_id8`)
    // is reachable and governed, rather than silently absent.
    const target = tools.find((t) => baseToolName(t.name) === baseToolName(tool))
    if (!target) {
      // One shape for the remaining causes - not granted, destructive, or not
      // a Shopify tool at all. Distinguishing THOSE would leak which tools
      // exist and which are merely ungranted.
      res.status(404).json({ error: 'tool_not_available', tool })
      return
    }

    const ctx = await makeBrainContextResolver(workspaceId, `app:shopify`, null, 'app_shopify')()
    if ('error' in ctx) {
      res.status(409).json({ error: 'no_assistant', detail: ctx.error })
      return
    }

    let input: unknown
    try {
      // Re-parse through the tool's own schema: defaults and coercions are
      // load-bearing across this catalog, and the browser is not a trusted
      // source of shape.
      input = target.inputSchema.parse(args)
    } catch (err) {
      res.status(400).json({ error: 'invalid_args', detail: message(err) })
      return
    }

    try {
      const result = await target.execute(input, ctx)
      // A tool refusing (missing scope, throttled, bad filter) is a 200 with
      // `isError`, not a transport failure. The tool's own words are the best
      // explanation available - a generic message here would throw them away.
      res.json({ isError: Boolean(result.isError), data: result.data })
    } catch (err) {
      res.status(502).json({ error: 'tool_failed', detail: message(err) })
    }
  })

  router.post('/ask', opts.requireAuth, async (req, res) => {
    const parsed = askBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.message })
      return
    }
    const { workspaceId, task } = parsed.data
    if (!(await guard(req as { userId?: string }, res, workspaceId))) return

    try {
      // Capped at this surface's OWN tool ceiling by the caller's wiring, so
      // "ask the assistant to refund order 1042" cannot ladder around /call.
      const answer = await opts.askAssistant({ workspaceId, storeScope: STORE_SCOPE, task })
      res.json({ answer })
    } catch (err) {
      res.status(502).json({ error: 'assistant_failed', detail: message(err) })
    }
  })

  return router
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
