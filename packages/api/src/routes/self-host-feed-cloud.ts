/**
 * Local API for linking an OSS Feed to paid hosted provider capabilities.
 *
 * [COMP:api/self-host-feed-cloud-link]
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { query } from '../db/client.js'
import { findAssistantById } from '../db/users.js'
import { getWorkspaceMembershipSystem } from '../db/workspace-store.js'
import type {
  FeedCloudLink,
  SelfHostFeedCloudLinkStore,
} from '../db/self-host-feed-cloud-link-store.js'
import type { SavedContentDraft } from '../db/content-planning-store.js'

type CloudFetch = typeof fetch

export type SelfHostFeedCloudRouteOptions = {
  cloudBaseUrl: string
  localAppUrl: string
  store: SelfHostFeedCloudLinkStore
  fetchImpl?: CloudFetch
}

function cloudBase(raw: string): string {
  const url = new URL(raw)
  return url.toString().replace(/\/$/, '')
}

async function requireWorkspaceMember(
  userId: string | undefined,
  workspaceId: string,
  res: Response,
  admin = false,
): Promise<boolean> {
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return false }
  const membership = await getWorkspaceMembershipSystem(userId, workspaceId)
  if (!membership) {
    res.status(403).json({ error: 'Not a member of this workspace.' })
    return false
  }
  if (admin && membership.role !== 'owner' && membership.role !== 'admin') {
    res.status(403).json({ error: 'Workspace admin access is required.' })
    return false
  }
  return true
}

export function publicFeedCloudLink(link: FeedCloudLink | null) {
  if (!link) return { state: 'unlinked' as const }
  return {
    state: link.status,
    assistantId: link.assistantId,
    userCode: link.userCode,
    verificationUrl: link.verificationUrl,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    hostedWorkspaceName: link.hostedWorkspaceName,
    hostedAssistantName: link.hostedAssistantName,
    plan: link.hostedPlan,
    entitlements: link.entitlements,
    lastCheckedAt: link.lastCheckedAt?.toISOString() ?? null,
    error: link.lastError,
    disclosure: {
      sendsPostContent: true,
      sendsAccountMetadata: true,
      sendsCompanyBrain: false,
    },
  }
}

export function selfHostFeedCloudRoutes(
  options: SelfHostFeedCloudRouteOptions,
): Router {
  const router = Router()
  const fetchImpl = options.fetchImpl ?? fetch
  const base = cloudBase(options.cloudBaseUrl)
  const localOrigin = new URL(options.localAppUrl).origin

  router.get('/:workspaceId/status', async (req, res) => {
    if (!(await requireWorkspaceMember(req.userId, req.params.workspaceId, res))) return
    res.json(publicFeedCloudLink(await options.store.get(req.params.workspaceId)))
  })

  router.post('/:workspaceId/start', async (req, res) => {
    const { workspaceId } = req.params
    if (!(await requireWorkspaceMember(req.userId, workspaceId, res, true))) return
    const assistantId = req.body?.assistantId
    if (typeof assistantId !== 'string') {
      res.status(400).json({ error: 'assistantId is required.' })
      return
    }
    const pending = await options.store.get(workspaceId)
    if (
      pending?.status === 'pending'
      && pending.assistantId === assistantId
      && !!pending.expiresAt
      && pending.expiresAt.getTime() > Date.now()
    ) {
      res.json(publicFeedCloudLink(pending))
      return
    }
    const assistant = await findAssistantById(assistantId)
    if (
      !assistant
      || assistant.workspaceId !== workspaceId
      || assistant.kind !== 'app'
      || assistant.appType !== 'distribution'
      || assistant.clearance !== 'public'
    ) {
      res.status(400).json({ error: 'Select a public Feed distribution assistant.' })
      return
    }
    const workspace = await query<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [workspaceId])
    if (!workspace.rows[0]) { res.status(404).json({ error: 'Workspace not found.' }); return }

    const deviceSecret = randomBytes(32).toString('base64url')
    const installationId = randomUUID()
    let response: globalThis.Response
    try {
      response = await fetchImpl(`${base}/api/self-host-feed/link/device`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceSecretHash: createHash('sha256').update(deviceSecret).digest('hex'),
          localInstallationId: installationId,
          localWorkspaceId: workspaceId,
          localWorkspaceName: workspace.rows[0].name,
          localAssistantId: assistant.id,
          localAssistantName: assistant.name,
          localOrigin,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      console.error('[self-host-feed-cloud] device request failed:', error)
      res.status(502).json({ error: 'Could not reach the Use Brian cloud service.' })
      return
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      res.status(response.status >= 500 ? 502 : response.status).json({
        error: typeof body.error === 'string' ? body.error : 'Cloud Link request failed.',
      })
      return
    }
    if (
      typeof body.deviceCode !== 'string'
      || typeof body.userCode !== 'string'
      || typeof body.verificationUrl !== 'string'
      || typeof body.expiresAt !== 'string'
    ) {
      res.status(502).json({ error: 'Cloud Link service returned an invalid response.' })
      return
    }
    const link = await options.store.savePending({
      workspaceId,
      assistantId,
      installationId,
      cloudBaseUrl: base,
      localOrigin,
      deviceCode: body.deviceCode,
      deviceSecret,
      userCode: body.userCode,
      verificationUrl: body.verificationUrl,
      expiresAt: new Date(body.expiresAt),
      createdBy: req.userId!,
    })
    res.status(201).json(publicFeedCloudLink(link))
  })

  router.post('/:workspaceId/poll', async (req, res) => {
    const { workspaceId } = req.params
    if (!(await requireWorkspaceMember(req.userId, workspaceId, res, true))) return
    const record = await options.store.getWithCredential(workspaceId)
    if (!record?.link.deviceCode || !record.credential.deviceSecret) {
      res.status(409).json({ error: 'There is no pending Cloud Link request.' })
      return
    }
    let response: globalThis.Response
    try {
      response = await fetchImpl(`${record.link.cloudBaseUrl}/api/self-host-feed/link/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceCode: record.link.deviceCode,
          deviceSecret: record.credential.deviceSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      console.error('[self-host-feed-cloud] token poll failed:', error)
      res.status(502).json({ error: 'Could not reach the Use Brian cloud service.' })
      return
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (response.status === 202) {
      res.status(202).json(publicFeedCloudLink(record.link))
      return
    }
    if (response.status === 402) {
      await options.store.markPlanRequired(workspaceId, typeof body.plan === 'string' ? body.plan : undefined)
      res.status(402).json({ error: body.error, code: 'CLOUD_PLAN_REQUIRED' })
      return
    }
    if (!response.ok || !linkedTokenBody(body)) {
      const message = typeof body.error === 'string' ? body.error : 'Cloud Link approval failed.'
      await options.store.markError(workspaceId, message)
      res.status(response.status >= 500 ? 502 : response.status).json({ error: message, code: body.code })
      return
    }
    await options.store.markLinked({
      workspaceId,
      accessToken: body.accessToken,
      hostedLinkId: body.linkId,
      hostedWorkspaceId: body.hostedWorkspaceId,
      hostedWorkspaceName: body.hostedWorkspaceName,
      hostedAssistantId: body.hostedAssistantId,
      hostedAssistantName: body.hostedAssistantName,
      hostedPlan: body.plan,
      entitlements: body.entitlements,
    })
    res.json(publicFeedCloudLink(await options.store.get(workspaceId)))
  })

  router.delete('/:workspaceId', async (req, res) => {
    const { workspaceId } = req.params
    if (!(await requireWorkspaceMember(req.userId, workspaceId, res, true))) return
    const record = await options.store.getWithCredential(workspaceId)
    if (record?.credential.accessToken) {
      try {
        await fetchImpl(`${record.link.cloudBaseUrl}/api/self-host-feed/gateway/link`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${record.credential.accessToken}` },
          signal: AbortSignal.timeout(5_000),
        })
      } catch (error) {
        console.warn('[self-host-feed-cloud] remote revoke unavailable:', error)
      }
    }
    await options.store.remove(workspaceId)
    res.json({ ok: true, state: 'unlinked' })
  })

  return router
}

export function selfHostFeedManagedDistributionRoutes(
  options: Pick<SelfHostFeedCloudRouteOptions, 'store' | 'fetchImpl'>,
): Router {
  const router = Router()
  const fetchImpl = options.fetchImpl ?? fetch

  const forward = async (req: Request, res: Response, next: () => void) => {
    const target = await resolveLinkForDistributionRequest(req, options.store)
    if (!target) { next(); return }
    if (target.link.status === 'plan_required') {
      res.status(402).json({ error: 'A paid hosted plan is required.', code: 'CLOUD_PLAN_REQUIRED' })
      return
    }
    if (!target.credential.accessToken) { next(); return }
    const headers: Record<string, string> = {
      authorization: `Bearer ${target.credential.accessToken}`,
      accept: 'application/json',
    }
    let body: string | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(req.body ?? {})
    }
    let response: globalThis.Response
    try {
      response = await fetchImpl(
        `${target.link.cloudBaseUrl}/api/self-host-feed/gateway/distribution${req.url}`,
        { method: req.method, headers, body, signal: AbortSignal.timeout(30_000) },
      )
    } catch (error) {
      console.error('[self-host-feed-cloud] managed request failed:', error)
      res.status(502).json({ error: 'Managed Feed service is unavailable.', code: 'CLOUD_UNAVAILABLE' })
      return
    }
    const responseBody = await response.json().catch(() => ({})) as Record<string, unknown>
    if (response.status === 402) {
      await options.store.markPlanRequired(target.link.workspaceId, typeof responseBody.plan === 'string' ? responseBody.plan : undefined)
    } else if (response.ok) {
      const plan = response.headers.get('x-usebrian-cloud-plan')
      if (plan) {
        await options.store.touchEntitlement({
          workspaceId: target.link.workspaceId,
          plan,
          entitlements: target.link.entitlements,
        })
      }
    }
    res.status(response.status).json(responseBody)
  }

  router.get('/team/:workspaceId/profiles', forward)
  router.get('/:assistantId', forward)
  router.patch(['/:assistantId/threads', '/:assistantId/twitter'], forward)
  router.delete(['/:assistantId/threads', '/:assistantId/twitter'], forward)
  router.get('/:assistantId/external-post', forward)
  router.get('/:assistantId/embed-html', forward)
  router.get(['/:assistantId/threads/insights', '/:assistantId/twitter/insights'], forward)
  router.get(['/:assistantId/threads/mentions', '/:assistantId/twitter/mentions'], forward)
  router.get('/:assistantId/twitter/quotes', forward)
  router.get('/:assistantId/twitter/lists', forward)
  router.get(['/:assistantId/threads/inspiration', '/:assistantId/twitter/inspiration'], forward)
  router.put(['/:assistantId/threads/inspiration', '/:assistantId/twitter/inspiration'], forward)
  router.post(['/:assistantId/threads/inspiration/scan', '/:assistantId/twitter/inspiration/scan'], forward)
  return router
}

export function selfHostFeedOAuthRelayRoutes(
  platform: 'threads' | 'twitter',
  options: Pick<SelfHostFeedCloudRouteOptions, 'store' | 'fetchImpl'>,
): Router {
  const router = Router()
  const fetchImpl = options.fetchImpl ?? fetch
  router.get('/authorize', async (req, res) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const assistantId = typeof req.query.assistantId === 'string' ? req.query.assistantId : ''
    const assistant = assistantId ? await findAssistantById(assistantId) : null
    if (!assistant?.workspaceId) { res.status(400).json({ error: 'Invalid Feed assistant.' }); return }
    if (!(await requireWorkspaceMember(req.userId, assistant.workspaceId, res, true))) return
    const record = await options.store.getWithCredential(assistant.workspaceId)
    if (!record?.credential.accessToken || record.link.status !== 'linked') {
      res.status(409).json({ error: 'Connect this Feed to a paid Use Brian workspace first.', code: 'CLOUD_LINK_REQUIRED' })
      return
    }
    const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : undefined
    const url = new URL(`/api/self-host-feed/gateway/${platform}-oauth/authorize`, record.link.cloudBaseUrl)
    url.searchParams.set('assistantId', assistantId)
    if (returnTo) url.searchParams.set('return_to', returnTo)
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${record.credential.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
    const body = await response.json().catch(() => ({}))
    res.status(response.status).json(body)
  })
  return router
}

/**
 * Managed delivery seam for the open content-planning approval route. Only
 * original, text-only post formats are automatic in v1; every other shape
 * remains honestly available in the manual ready queue.
 */
export function createSelfHostFeedCloudPublisher(options: {
  store: SelfHostFeedCloudLinkStore
  fetchImpl?: CloudFetch
  resolveAssistant?: typeof findAssistantById
}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolveAssistant = options.resolveAssistant ?? findAssistantById
  return async (
    draft: SavedContentDraft,
  ): Promise<{ status: 'posted'; permalink?: string } | { status: 'manual'; reason: string }> => {
    if (draft.platform !== 'threads' && draft.platform !== 'twitter') {
      return { status: 'manual', reason: 'platform_manual_only' }
    }
    if (
      draft.postFormat !== 'post'
      || draft.media.length > 0
      || !!draft.replyExternalId
    ) {
      return { status: 'manual', reason: 'format_manual_only' }
    }
    const assistant = await resolveAssistant(draft.assistantId)
    if (!assistant?.workspaceId) return { status: 'manual', reason: 'workspace_missing' }
    const record = await options.store.getWithCredential(assistant.workspaceId)
    if (!record?.credential.accessToken || record.link.status !== 'linked') {
      return { status: 'manual', reason: 'cloud_link_unavailable' }
    }
    const text = draft.finalText ?? draft.draftText
    const revision = createHash('sha256')
      .update(JSON.stringify({ text, topicTag: draft.topicTag }))
      .digest('hex')
      .slice(0, 24)
    const response = await fetchImpl(
      `${record.link.cloudBaseUrl}/api/self-host-feed/gateway/publish`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${record.credential.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          platform: draft.platform,
          text,
          topicTag: draft.topicTag ?? undefined,
          idempotencyKey: `draft:${draft.id}:${revision}`,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (response.status === 402) {
      await options.store.markPlanRequired(
        assistant.workspaceId,
        typeof body.plan === 'string' ? body.plan : undefined,
      )
    }
    if (!response.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : 'Managed publish failed.')
    }
    return {
      status: 'posted',
      ...(typeof body.permalink === 'string' ? { permalink: body.permalink } : {}),
    }
  }
}

async function resolveLinkForDistributionRequest(
  req: Request,
  store: SelfHostFeedCloudLinkStore,
) {
  const workspaceId = typeof req.params.workspaceId === 'string'
    ? req.params.workspaceId
    : undefined
  if (workspaceId) return store.getWithCredential(workspaceId)
  const assistantId = typeof req.params.assistantId === 'string'
    ? req.params.assistantId
    : undefined
  if (!assistantId) return null
  const assistant = await findAssistantById(assistantId)
  return assistant?.workspaceId ? store.getWithCredential(assistant.workspaceId) : null
}

function linkedTokenBody(body: Record<string, unknown>): body is Record<string, unknown> & {
  accessToken: string
  linkId: string
  hostedWorkspaceId: string
  hostedWorkspaceName: string
  hostedAssistantId: string
  hostedAssistantName: string
  plan: string
  entitlements: Record<string, boolean>
} {
  return [
    body.accessToken,
    body.linkId,
    body.hostedWorkspaceId,
    body.hostedWorkspaceName,
    body.hostedAssistantId,
    body.hostedAssistantName,
    body.plan,
  ].every((value) => typeof value === 'string')
    && !!body.entitlements
    && typeof body.entitlements === 'object'
    && !Array.isArray(body.entitlements)
}
