/** Administrative API for custom OpenAI-compatible connections and profiles. */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  CUSTOM_LLM_TIERS,
  CustomLlmEncryptionKeyRequiredError,
  isCustomLlmTier,
  type WorkspaceCustomLlmEndpoint,
  type WorkspaceCustomLlmEndpointStore,
  type WorkspaceCustomLlmProfile,
} from '../db/workspace-custom-llm-endpoints.js'
import {
  CustomLlmProbeError,
  customLlmAlias,
  normalizeCustomLlmBaseUrl,
  probeCustomLlmEndpoint,
  type CustomLlmConnectionInput,
  type CustomLlmNetworkPolicy,
} from '../custom-llm-runtime.js'
import { isSelfHostedOssEnv } from './local-session.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ProfileBody = z.object({
  name: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(4_000_000),
  maxOutputTokens: z.number().int().min(64).max(262_144),
}).strict()

const EndpointBody = ProfileBody.extend({
  baseUrl: z.string().trim().min(8).max(2048),
  apiKey: z.string().trim().max(2048).nullable().optional(),
}).strict()

const TierBody = z.object({ profileId: z.string().uuid() }).strict()

type Options = {
  endpointStore: WorkspaceCustomLlmEndpointStore
  workspaceStore: WorkspaceStore
  networkPolicy?: CustomLlmNetworkPolicy
  probe?: (input: CustomLlmConnectionInput) => Promise<{ supportsTools: true; verifiedAt: Date }>
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505'
}

function serializeProfile(profile: WorkspaceCustomLlmProfile) {
  return { ...profile, selector: customLlmAlias(profile.id) }
}

function serializeEndpoint(endpoint: WorkspaceCustomLlmEndpoint) {
  return { ...endpoint, profiles: endpoint.profiles.map(serializeProfile) }
}

export function workspaceCustomLlmEndpointsRoutes(opts: Options): Router {
  const router = Router({ mergeParams: true })
  const networkPolicy = opts.networkPolicy ?? (isSelfHostedOssEnv() ? 'private-network' : 'public-only')
  const probe = opts.probe ?? ((input: CustomLlmConnectionInput) => probeCustomLlmEndpoint(input, { networkPolicy }))

  async function gate(req: Request, res: Response): Promise<string | null> {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : ''
    if (!UUID_RE.test(workspaceId)) {
      res.status(400).json({ error: 'Invalid workspace id' })
      return null
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Only workspace admins can manage custom model endpoints' })
      return null
    }
    return workspaceId
  }

  const sendError = (res: Response, err: unknown, fallback: string): void => {
    if (err instanceof CustomLlmProbeError) {
      res.status(err.httpStatus).json({ error: err.message, code: err.code })
      return
    }
    if (err instanceof CustomLlmEncryptionKeyRequiredError) {
      res.status(422).json({
        error: 'Bearer-key storage is not configured on this Brian server',
        code: 'encryption_not_configured',
      })
      return
    }
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'A connection or profile with this name already exists', code: 'duplicate_name' })
      return
    }
    console.error('[custom-llm-endpoints] request failed:', err)
    res.status(500).json({ error: fallback })
  }

  router.get('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      const [endpoints, tierDefaults] = await Promise.all([
        opts.endpointStore.list({ actingUserId: req.userId!, workspaceId }),
        opts.endpointStore.listTierDefaults({ actingUserId: req.userId!, workspaceId }),
      ])
      res.json({ endpoints: endpoints.map(serializeEndpoint), tierDefaults })
    } catch (err) {
      sendError(res, err, 'Failed to list custom model endpoints')
    }
  })

  router.post('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const parsed = EndpointBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', code: 'invalid_input', detail: parsed.error.message })
      return
    }
    try {
      const baseUrl = normalizeCustomLlmBaseUrl(parsed.data.baseUrl, networkPolicy)
      const verified = await probe({ baseUrl, apiKey: parsed.data.apiKey, modelId: parsed.data.modelId })
      const endpoint = await opts.endpointStore.create({
        actingUserId: req.userId!,
        workspaceId,
        input: { ...parsed.data, baseUrl, ...verified },
      })
      res.status(201).json({ endpoint: serializeEndpoint(endpoint) })
    } catch (err) {
      sendError(res, err, 'Failed to save custom model endpoint')
    }
  })

  router.post('/:endpointId/profiles', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const endpointId = typeof req.params.endpointId === 'string' ? req.params.endpointId : ''
    if (!UUID_RE.test(endpointId)) {
      res.status(400).json({ error: 'Invalid endpoint id', code: 'invalid_input' })
      return
    }
    const parsed = ProfileBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', code: 'invalid_input', detail: parsed.error.message })
      return
    }
    try {
      const endpoint = await opts.endpointStore.getEndpointRuntimeSystem({ workspaceId, endpointId })
      if (!endpoint) {
        res.status(404).json({ error: 'Endpoint not found' })
        return
      }
      const verified = await probe({ baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, modelId: parsed.data.modelId })
      const profile = await opts.endpointStore.createProfile({
        actingUserId: req.userId!,
        workspaceId,
        endpointId,
        input: { ...parsed.data, ...verified },
      })
      if (!profile) {
        res.status(404).json({ error: 'Endpoint not found' })
        return
      }
      res.status(201).json({ profile: serializeProfile(profile) })
    } catch (err) {
      sendError(res, err, 'Failed to save custom model profile')
    }
  })

  router.put('/tiers/:tier', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const tier = typeof req.params.tier === 'string' ? req.params.tier : ''
    if (!isCustomLlmTier(tier)) {
      res.status(400).json({ error: 'Unknown model tier', code: 'invalid_input' })
      return
    }
    const parsed = TierBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', code: 'invalid_input' })
      return
    }
    try {
      const setting = await opts.endpointStore.setTierDefault({
        actingUserId: req.userId!, workspaceId, tier, profileId: parsed.data.profileId,
      })
      if (!setting) {
        res.status(404).json({ error: 'Profile not found' })
        return
      }
      res.json({ tierDefault: setting })
    } catch (err) {
      sendError(res, err, 'Failed to update the custom model tier')
    }
  })

  router.delete('/tiers/:tier', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const tier = typeof req.params.tier === 'string' ? req.params.tier : ''
    if (!isCustomLlmTier(tier)) {
      res.status(400).json({ error: 'Unknown model tier', code: 'invalid_input' })
      return
    }
    try {
      await opts.endpointStore.clearTierDefault({ actingUserId: req.userId!, workspaceId, tier })
      res.status(204).end()
    } catch (err) {
      sendError(res, err, 'Failed to clear the custom model tier')
    }
  })

  // Compatibility with the original one-default endpoint API: the endpoint's
  // preserved first-profile id equals its connection id, so setting it maps
  // all user-facing tiers to that profile.
  router.put('/:endpointId/default', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const endpointId = typeof req.params.endpointId === 'string' ? req.params.endpointId : ''
    if (!UUID_RE.test(endpointId)) return void res.status(400).json({ error: 'Invalid endpoint id' })
    try {
      const settings = []
      for (const tier of CUSTOM_LLM_TIERS) {
        const setting = await opts.endpointStore.setTierDefault({
          actingUserId: req.userId!, workspaceId, tier, profileId: endpointId,
        })
        if (!setting) return void res.status(404).json({ error: 'Endpoint profile not found' })
        settings.push(setting)
      }
      res.json({ tierDefaults: settings })
    } catch (err) {
      sendError(res, err, 'Failed to set custom model defaults')
    }
  })

  router.delete('/default', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      for (const tier of CUSTOM_LLM_TIERS) {
        await opts.endpointStore.clearTierDefault({ actingUserId: req.userId!, workspaceId, tier })
      }
      res.status(204).end()
    } catch (err) {
      sendError(res, err, 'Failed to clear custom model defaults')
    }
  })

  router.delete('/:endpointId/profiles/:profileId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const endpointId = typeof req.params.endpointId === 'string' ? req.params.endpointId : ''
    const profileId = typeof req.params.profileId === 'string' ? req.params.profileId : ''
    if (!UUID_RE.test(endpointId) || !UUID_RE.test(profileId)) {
      res.status(400).json({ error: 'Invalid endpoint or profile id', code: 'invalid_input' })
      return
    }
    try {
      const removed = await opts.endpointStore.deleteProfile({
        actingUserId: req.userId!, workspaceId, endpointId, profileId,
      })
      if (!removed) return void res.status(404).json({ error: 'Profile not found' })
      res.status(204).end()
    } catch (err) {
      sendError(res, err, 'Failed to delete custom model profile')
    }
  })

  router.delete('/:endpointId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const endpointId = typeof req.params.endpointId === 'string' ? req.params.endpointId : ''
    if (!UUID_RE.test(endpointId)) {
      res.status(400).json({ error: 'Invalid endpoint id', code: 'invalid_input' })
      return
    }
    try {
      await opts.endpointStore.delete({ actingUserId: req.userId!, workspaceId, endpointId })
      res.status(204).end()
    } catch (err) {
      sendError(res, err, 'Failed to delete custom model endpoint')
    }
  })

  return router
}
