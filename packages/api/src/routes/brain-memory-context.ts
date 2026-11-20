/** Signed-in retrieval and single-memory clipboard preparation. [COMP:api/memory-context-copy] */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { DerivedScopeError } from '@use-brian/agent-runtime/security/derived-scope.js'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { isAuthorityChangedError } from '../context-scope/authority-lease.js'
import type { AuthTokenClaims } from '../db/auth-session-store.js'
import { readMemoryContext, searchMemoryContext } from '../memory-context-read.js'
import { resolveNativeWorkspaceReadAuthority } from './native-workspace-read-authority.js'
import { pinSessionTitleClaims } from './session-title-authority.js'

const workspaceId = z.string().uuid().toLowerCase()
const search = z.object({ workspaceId, query: z.string().trim().min(1).max(200) }).strict()
const read = z.object({ workspaceId, id: z.string().uuid().toLowerCase(), purpose: z.enum(['preview', 'copy']) }).strict()
const copied = z.object({ receipt: z.string().regex(/^\d{13}\.[\w-]{22}\.[\w-]{43}$/) }).strict()
const RECEIPT_LIFETIME_MS = 2 * 60_000
const REPLAY_LIMIT = 4096

function signature(secret: string, body: string, claims: Readonly<AuthTokenClaims>) {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['memory-context-copied', body, claims.userId, claims.sessionId, claims.authVersion]))
    .digest('base64url')
}

export function brainMemoryContextRoutes(telemetry?: { secret: string; observe: () => void }): Router {
  const router = Router()
  const consumed = new Set<string>()

  function issueReceipt(claims: Readonly<AuthTokenClaims>) {
    if (!telemetry || !claims.sessionId) return undefined
    const body = `${Date.now() + RECEIPT_LIFETIME_MS}.${randomBytes(16).toString('base64url')}`
    return `${body}.${signature(telemetry.secret, body, claims)}`
  }

  // Resolve a new authority on every search, preview and copy request.
  async function authorized<T>(req: Request, res: Response, input: { workspaceId: string }, run: (
    authority: Awaited<ReturnType<typeof resolveNativeWorkspaceReadAuthority>>, claims: Readonly<AuthTokenClaims>,
  ) => Promise<T>): Promise<T> {
    const claims = pinSessionTitleClaims(req)
    if (!claims) throw new DerivedScopeError('scope_evidence_missing')
    const disconnected = new AbortController()
    const onClose = () => disconnected.abort()
    res.once('close', onClose)
    const timeout = AbortSignal.timeout(15_000)
    const abortSignal = AbortSignal.any([timeout, disconnected.signal])
    try {
      const authority = await resolveNativeWorkspaceReadAuthority({ claims, workspaceId: input.workspaceId, abortSignal })
      const result = await run(authority, claims)
      await authority.execution.security.authority.assertCurrent()
      abortSignal.throwIfAborted()
      return result
    } catch (error) {
      timeout.throwIfAborted()
      throw error
    } finally {
      res.off('close', onClose)
    }
  }

  function statusFor(error: unknown) {
    return error instanceof DerivedScopeError || isAuthorityChangedError(error)
      || error instanceof SourceProtocolError && error.code === 'source_access_denied' ? 404 : 503
  }

  router.post('/memories/context/search', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const input = search.safeParse(req.body)
    if (!input.success) { res.status(400).json({ error: 'invalid_memory_context_request' }); return }
    try {
      const memories = await authorized(req, res, input.data, authority => searchMemoryContext(authority, input.data.query))
      res.json({ memories })
    } catch (error) {
      if (!res.destroyed) res.status(statusFor(error)).json({ error: 'memory_context_unavailable' })
    }
  })

  router.post('/memories/context/read', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    const input = read.safeParse(req.body)
    if (!input.success) { res.status(400).json({ error: 'invalid_memory_context_request' }); return }
    try {
      const result = await authorized(req, res, input.data, async (authority, claims) => {
        const memory = await readMemoryContext(authority, input.data.id)
        return memory && { memory, receipt: input.data.purpose === 'copy' ? issueReceipt(claims) : undefined }
      })
      if (!result) { res.status(404).json({ error: 'memory_context_unavailable' }); return }
      res.json(result)
    } catch (error) {
      if (!res.destroyed) res.status(statusFor(error)).json({ error: 'memory_context_unavailable' })
    }
  })

  router.post('/memories/context/copied', (req, res) => {
    res.set('Cache-Control', 'no-store')
    const input = copied.safeParse(req.body)
    const claims = pinSessionTitleClaims(req)
    if (!telemetry || !input.success || !claims?.sessionId) { res.sendStatus(404); return }
    const { receipt } = input.data
    const [expires, nonce, proof] = receipt.split('.')
    if (Number(expires) <= Date.now() || !timingSafeEqual(Buffer.from(proof), Buffer.from(signature(telemetry.secret, `${expires}.${nonce}`, claims)))) {
      res.sendStatus(404)
      return
    }
    if (!consumed.has(receipt)) {
      consumed.add(receipt)
      if (consumed.size > REPLAY_LIMIT) consumed.delete(consumed.values().next().value!)
      telemetry.observe()
    }
    res.sendStatus(204)
  })
  return router
}
