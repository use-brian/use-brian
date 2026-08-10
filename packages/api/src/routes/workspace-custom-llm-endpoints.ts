/** Administrative API for verified workspace custom OpenAI-compatible endpoints. */

import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  CustomLlmEncryptionKeyRequiredError,
  type WorkspaceCustomLlmEndpointStore,
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

const EndpointBody = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(8).max(2048),
  apiKey: z.string().trim().max(2048).nullable().optional(),
  modelId: z.string().trim().min(1).max(200),
  contextWindow: z.number().int().min(1024).max(4_000_000),
  maxOutputTokens: z.number().int().min(64).max(262_144),
  isDefault: z.boolean().optional(),
}).strict()

type Options = {
  endpointStore: WorkspaceCustomLlmEndpointStore
  workspaceStore: WorkspaceStore
  networkPolicy?: CustomLlmNetworkPolicy
  probe?: (input: CustomLlmConnectionInput) => Promise<{ supportsTools: true; verifiedAt: Date }>
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === '23505'
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
      res.status(409).json({ error: 'An endpoint with this name already exists', code: 'duplicate_name' })
      return
    }
    console.error('[custom-llm-endpoints] request failed:', err)
    res.status(500).json({ error: fallback })
  }

  router.get('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      const endpoints = await opts.endpointStore.list({ actingUserId: req.userId!, workspaceId })
      res.json({ endpoints: endpoints.map((endpoint) => ({ ...endpoint, selector: customLlmAlias(endpoint.id) })) })
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
      const verified = await probe({
        baseUrl,
        apiKey: parsed.data.apiKey,
        modelId: parsed.data.modelId,
      })
      const endpoint = await opts.endpointStore.create({
        actingUserId: req.userId!,
        workspaceId,
        input: { ...parsed.data, baseUrl, ...verified },
      })
      res.status(201).json({ endpoint: { ...endpoint, selector: customLlmAlias(endpoint.id) } })
    } catch (err) {
      sendError(res, err, 'Failed to save custom model endpoint')
    }
  })

  router.put('/:endpointId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const endpointId = typeof req.params.endpointId === 'string' ? req.params.endpointId : ''
    if (!UUID_RE.test(endpointId)) {
      res.status(400).json({ error: 'Invalid endpoint id', code: 'invalid_input' })
      return
    }
    const parsed = EndpointBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', code: 'invalid_input', detail: parsed.error.message })
      return
    }
    try {
      const baseUrl = normalizeCustomLlmBaseUrl(parsed.data.baseUrl, networkPolicy)
      const verified = await probe({ baseUrl, apiKey: parsed.data.apiKey, modelId: parsed.data.modelId })
      const endpoint = await opts.endpointStore.update({
        actingUserId: req.userId!,
        workspaceId,
        endpointId,
        input: { ...parsed.data, baseUrl, ...verified },
      })
      if (!endpoint) {
        res.status(404).json({ error: 'Endpoint not found' })
        return
      }
      res.json({ endpoint: { ...endpoint, selector: customLlmAlias(endpoint.id) } })
    } catch (err) {
      sendError(res, err, 'Failed to update custom model endpoint')
    }
  })

  router.put('/:endpointId/default', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const endpointId = typeof req.params.endpointId === 'string' ? req.params.endpointId : ''
    if (!UUID_RE.test(endpointId)) {
      res.status(400).json({ error: 'Invalid endpoint id', code: 'invalid_input' })
      return
    }
    try {
      const endpoint = await opts.endpointStore.setDefault({ actingUserId: req.userId!, workspaceId, endpointId })
      if (!endpoint) {
        res.status(404).json({ error: 'Endpoint not found' })
        return
      }
      res.json({ endpoint: { ...endpoint, selector: customLlmAlias(endpoint.id) } })
    } catch (err) {
      sendError(res, err, 'Failed to set custom model default')
    }
  })

  router.delete('/default', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      await opts.endpointStore.clearDefault({ actingUserId: req.userId!, workspaceId })
      res.status(204).end()
    } catch (err) {
      sendError(res, err, 'Failed to clear custom model default')
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
