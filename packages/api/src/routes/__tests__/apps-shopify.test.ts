/**
 * [COMP:api/apps-shopify-route] — the built-in Shopify app's data path.
 *
 * These are security assertions, not behaviour tests. The thing being defended
 * is that moving Shopify from a sandboxed bundle to a native page did not
 * quietly open a second, wider way into the store.
 *
 * The route's whole safety property is that it EXECUTES tools and never
 * DECIDES them: the resolver's list is the allowlist. So the tests drive the
 * resolver, not the connector — if the route ever grows a branch that reaches
 * past what the resolver returned, these fail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { z } from 'zod'

const membership = vi.fn(async () => ({ role: 'member' }) as unknown)
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: (...a: unknown[]) => membership(...(a as [])),
}))
vi.mock('../../brain-mcp/tools.js', () => ({
  makeBrainContextResolver: () => async () => ({ userId: 'u1', workspaceId: WS }),
}))

const { appsShopifyRoutes } = await import('../apps-shopify.js')

const WS = '11111111-1111-4111-8111-111111111111'

type Exec = (input: unknown, ctx: unknown) => Promise<{ data: unknown; isError?: boolean }>

function tool(name: string, execute: Exec = async () => ({ data: { ok: name } })) {
  return { name, description: '', inputSchema: z.object({ q: z.string().optional() }), execute }
}

function app(tools: unknown[], askAssistant = vi.fn(async () => 'answer')) {
  const storeTools = vi.fn(async () => tools as never)
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { (req as { userId?: string }).userId = 'u1'; next() })
  a.use('/api/apps/shopify', appsShopifyRoutes({
    requireAuth: (_q, _s, n) => n(),
    storeTools,
    askAssistant,
  }))
  return { a, storeTools, askAssistant }
}

beforeEach(() => {
  membership.mockReset()
  membership.mockResolvedValue({ role: 'member' } as unknown)
})

describe('[COMP:api/apps-shopify-route] the resolver decides, the route executes', () => {
  it('refuses a tool the resolver did not return', async () => {
    // The core assertion. `shopifyRefundOrder` is destructive, so
    // `store-tools.ts` excludes it at every tier and it never appears in the
    // resolved list. If the route ever resolved names itself, this passes
    // while the app gains a refund button.
    const { a } = app([tool('shopifyListOrders')])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyRefundOrder', args: {} })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('tool_not_available')
  })

  it('asks the resolver for the ONE destructive tool this surface may reach, and no other', async () => {
    // `alsoAllow` is a literal of names, not a tier or a flag - so the
    // widening is enumerable by reading it and cannot grow by class. The three
    // destructive tools that move money stay out; the one whose containment is
    // server-enforced and whose write is inert comes in.
    const { a, storeTools } = app([tool('shopifyGetShop')])
    await request(a).get(`/api/apps/shopify/tools?workspaceId=${WS}`)
    // Asserted as an EXACT array rather than a `toContain`: the point is what
    // is absent, and a containment check would pass on a list that had grown.
    expect(storeTools).toHaveBeenCalledWith(
      expect.objectContaining({ alsoAllow: ['shopifyCreateProductTemplate'] }),
    )
  })

  it('executes shopifyCreateProductTemplate once the resolver returns it', async () => {
    const exec = vi.fn(async () => ({ data: { filename: 'templates/product.amla.json' } }))
    const { a } = app([tool('shopifyCreateProductTemplate', exec)])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyCreateProductTemplate', args: {} })
    expect(res.status).toBe(200)
    expect(exec).toHaveBeenCalled()
  })

  it('does NOT widen the assistant consult', async () => {
    // A model choosing to write a theme file is a different decision from a
    // merchant clicking a confirm, so `/ask` keeps the ceiling it always had.
    const { a, askAssistant } = app([tool('shopifyGetShop')])
    await request(a).post('/api/apps/shopify/ask').send({ workspaceId: WS, task: 'do a thing' })
    expect(askAssistant).toHaveBeenCalledWith({ workspaceId: WS, storeScope: 'write', task: 'do a thing' })
  })

  it('executes a tool the resolver did return', async () => {
    const exec = vi.fn(async () => ({ data: { name: 'Brian Test' } }))
    const { a } = app([tool('shopifyGetShop', exec)])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyGetShop', args: {} })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ isError: false, data: { name: 'Brian Test' } })
    expect(exec).toHaveBeenCalledOnce()
  })

  it('says the STORE is unavailable, not that the tool is, when nothing resolves', async () => {
    // Found live: an expired token 401s, the health probe flips the instance to
    // `auth_failed`, and the resolver returns nothing. Reporting that as
    // "tool not available" points at a grant, when the fix is reconnecting.
    const { a } = app([]);
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyGetShop' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('store_unavailable')
  })

  it('reports zero tools rather than failing when nothing is exposed', async () => {
    // An unexposed connector is the single likeliest real-world state, and it
    // is a thing the owner can fix in Studio. It must read as "not connected",
    // never as a broken page.
    const { a } = app([])
    const res = await request(a).get(`/api/apps/shopify/tools?workspaceId=${WS}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tools: [], connected: false })
  })

  it('asks the resolver at the fixed tier, and passes the workspace through', async () => {
    const { a, storeTools } = app([tool('shopifyGetShop')])
    await request(a).post('/api/apps/shopify/call').send({ workspaceId: WS, tool: 'shopifyGetShop' })
    expect(storeTools).toHaveBeenCalledWith({
      workspaceId: WS,
      storeScope: 'write',
      alsoAllow: ['shopifyCreateProductTemplate'],
    })
  })

  it('matches a multi-store suffixed tool by its canonical name', async () => {
    // `name__label_id8` is how a second store's tools arrive. Matching the raw
    // string would make them unreachable AND ungoverned.
    const { a } = app([tool('shopifyGetShop__mystore_1a2b3c4d')])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyGetShop' })
    expect(res.status).toBe(200)
  })
})

describe('[COMP:api/apps-shopify-route] naming a workspace is not belonging to it', () => {
  it('refuses a caller who is not a member', async () => {
    membership.mockResolvedValue(null as unknown)
    const { a, storeTools } = app([tool('shopifyGetShop')])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyGetShop' })
    expect(res.status).toBe(403)
    // And it must refuse BEFORE touching the store.
    expect(storeTools).not.toHaveBeenCalled()
  })

  it('guards the tools listing too, not just the call', async () => {
    membership.mockResolvedValue(null as unknown)
    const { a, storeTools } = app([tool('shopifyGetShop')])
    const res = await request(a).get(`/api/apps/shopify/tools?workspaceId=${WS}`)
    expect(res.status).toBe(403)
    expect(storeTools).not.toHaveBeenCalled()
  })

  it('guards the assistant consult too - it reaches the same tools', async () => {
    membership.mockResolvedValue(null as unknown)
    const { a, askAssistant } = app([])
    const res = await request(a).post('/api/apps/shopify/ask')
      .send({ workspaceId: WS, task: 'refund order 1042' })
    expect(res.status).toBe(403)
    expect(askAssistant).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/apps-shopify-route] failure shapes', () => {
  it('surfaces a tool refusal as isError, not as a transport failure', async () => {
    // A missing scope or a throttle is the tool saying no, and its own words
    // are the best explanation available. Flattening it to a 502 would throw
    // away the one sentence that says what to fix.
    const exec = vi.fn(async () => ({ data: 'Shopify error: Required access: read_themes', isError: true }))
    const { a } = app([tool('shopifyListProductTemplates', exec)])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyListProductTemplates' })
    expect(res.status).toBe(200)
    expect(res.body.isError).toBe(true)
    expect(res.body.data).toContain('read_themes')
  })

  it('rejects args the tool schema refuses, without calling execute', async () => {
    const exec = vi.fn(async () => ({ data: {} }))
    const { a } = app([tool('shopifyGetShop', exec)])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: WS, tool: 'shopifyGetShop', args: { q: 42 } })
    expect(res.status).toBe(400)
    expect(exec).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid workspace before doing anything', async () => {
    const { a, storeTools } = app([tool('shopifyGetShop')])
    const res = await request(a).post('/api/apps/shopify/call')
      .send({ workspaceId: 'not-a-uuid', tool: 'shopifyGetShop' })
    expect(res.status).toBe(400)
    expect(storeTools).not.toHaveBeenCalled()
  })
})
