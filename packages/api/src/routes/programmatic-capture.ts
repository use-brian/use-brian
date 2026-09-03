/**
 * Workspace-admin CRUD for reusable assistant capture profiles.
 * [COMP:api/programmatic-capture]
 */

import { Router, type Request, type Response } from 'express'
import { computeNextRun } from '@use-brian/core'
import { z } from 'zod'
import type {
  CaptureRuleInput,
  ProgrammaticCaptureStore,
} from '../db/programmatic-capture-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'

const Uuid = z.string().uuid()

const ProfileBody = z.object({
  name: z.string().trim().min(1).max(120),
  partitionBy: z.enum(['connection', 'user', 'session', 'subject']),
  enabled: z.boolean().default(true),
}).strict()

const Scalar = z.union([z.string().max(500), z.number(), z.boolean()])
const FilterParams = z.union([
  z.object({}).strict(),
  z.object({ keywords: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict(),
  z.object({ values: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict(),
  z.object({
    key: z.string().min(1).max(80),
    value: Scalar.optional(),
    values: z.array(Scalar).min(1).max(50).optional(),
  }).strict().refine((value) => (value.value === undefined) !== (value.values === undefined), {
    message: 'metadata_match requires exactly one of value or values',
  }),
])

const RuleBody = z.object({
  ruleOrder: z.number().int().min(0).max(9999).optional(),
  filterType: z.enum(['always', 'keyword_match', 'actor_match', 'role_match', 'metadata_match']),
  filterParams: FilterParams.default({}),
  routingMode: z.enum(['realtime', 'scheduled', 'drop']),
  routingSchedule: z.string().trim().min(1).max(120).nullable().optional(),
  routingTimezone: z.string().trim().min(1).max(100).default('UTC'),
  episodeSensitivity: z.enum(['public', 'internal', 'confidential']).nullable().optional(),
  compartments: z.array(z.string().min(1).max(160)).max(50).default([]),
  projectIds: z.array(Uuid).max(50).default([]),
}).strict().superRefine((value, ctx) => {
  const params = value.filterParams as Record<string, unknown>
  if (value.filterType === 'always' && Object.keys(params).length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['filterParams'], message: 'always requires empty filterParams' })
  }
  if (value.filterType === 'keyword_match' && !Array.isArray(params.keywords)) {
    ctx.addIssue({ code: 'custom', path: ['filterParams'], message: 'keyword_match requires keywords' })
  }
  if (['actor_match', 'role_match'].includes(value.filterType) && !Array.isArray(params.values)) {
    ctx.addIssue({ code: 'custom', path: ['filterParams'], message: `${value.filterType} requires values` })
  }
  if (value.filterType === 'role_match' && Array.isArray(params.values)) {
    const allowed = new Set(['user', 'assistant', 'system', 'tool'])
    if (!params.values.every((entry) => typeof entry === 'string' && allowed.has(entry))) {
      ctx.addIssue({ code: 'custom', path: ['filterParams', 'values'], message: 'role values must be user, assistant, system, or tool' })
    }
  }
  if (value.filterType === 'metadata_match' && typeof params.key !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['filterParams'], message: 'metadata_match requires key and value(s)' })
  }
  if (value.routingMode === 'scheduled' && !value.routingSchedule) {
    ctx.addIssue({ code: 'custom', path: ['routingSchedule'], message: 'scheduled rules require a cron schedule' })
  }
  if (value.routingMode !== 'scheduled' && value.routingSchedule) {
    ctx.addIssue({ code: 'custom', path: ['routingSchedule'], message: 'only scheduled rules accept a schedule' })
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.routingTimezone }).format(new Date())
  } catch {
    ctx.addIssue({ code: 'custom', path: ['routingTimezone'], message: 'invalid IANA timezone' })
  }
  if (value.routingMode === 'scheduled' && value.routingSchedule) {
    try {
      computeNextRun({ type: 'cron', expression: value.routingSchedule }, value.routingTimezone)
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['routingSchedule'],
        message: err instanceof Error ? err.message : 'invalid cron schedule',
      })
    }
  }
})

type Options = {
  store: ProgrammaticCaptureStore
  workspaceStore: WorkspaceStore
}

export function programmaticCaptureRoutes(opts: Options): Router {
  const router = Router({ mergeParams: true })

  async function gate(req: Request, res: Response): Promise<string | null> {
    if (!req.userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : ''
    if (!Uuid.safeParse(workspaceId).success) {
      res.status(400).json({ error: 'Invalid workspace id' })
      return null
    }
    const role = await opts.workspaceStore.getRole(req.userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Workspace not found' })
      return null
    }
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'Only workspace admins can manage capture profiles' })
      return null
    }
    return workspaceId
  }

  function idParam(req: Request, name: string): string | null {
    const value = req.params[name]
    return typeof value === 'string' && Uuid.safeParse(value).success ? value : null
  }

  router.get('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    try {
      res.json({ profiles: await opts.store.listProfiles(req.userId!, workspaceId) })
    } catch (err) {
      console.error('[programmatic-capture] list failed:', err)
      res.status(500).json({ error: 'Failed to list capture profiles' })
    }
  })

  router.post('/', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const parsed = ProfileBody.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
    try {
      const profile = await opts.store.createProfile({
        actingUserId: req.userId!,
        workspaceId,
        ...parsed.data,
      })
      res.status(201).json({ profile })
    } catch (err) {
      console.error('[programmatic-capture] create failed:', err)
      res.status(500).json({ error: 'Failed to create capture profile' })
    }
  })

  router.put('/:profileId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const profileId = idParam(req, 'profileId')
    const parsed = ProfileBody.safeParse(req.body)
    if (!profileId || !parsed.success) return void res.status(400).json({ error: 'Invalid input' })
    try {
      const profile = await opts.store.updateProfile({
        actingUserId: req.userId!, workspaceId, profileId, ...parsed.data,
      })
      if (!profile) return void res.status(404).json({ error: 'Capture profile not found' })
      res.json({ profile })
    } catch (err) {
      console.error('[programmatic-capture] update failed:', err)
      res.status(500).json({ error: 'Failed to update capture profile' })
    }
  })

  router.delete('/:profileId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const profileId = idParam(req, 'profileId')
    if (!profileId) return void res.status(404).json({ error: 'Capture profile not found' })
    const deleted = await opts.store.deleteProfile(req.userId!, workspaceId, profileId)
    if (!deleted) return void res.status(404).json({ error: 'Capture profile not found' })
    res.status(204).end()
  })

  router.post('/:profileId/rules', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const profileId = idParam(req, 'profileId')
    const parsed = RuleBody.safeParse(req.body)
    if (!profileId || !parsed.success) {
      return void res.status(400).json({ error: 'Invalid input', detail: parsed.success ? undefined : parsed.error.message })
    }
    try {
      const rule = await opts.store.addRule({
        actingUserId: req.userId!, workspaceId, profileId, rule: parsed.data as CaptureRuleInput,
      })
      if (!rule) return void res.status(404).json({ error: 'Capture profile not found' })
      res.status(201).json({ rule })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return void res.status(409).json({ error: 'Rule order is already in use' })
      }
      console.error('[programmatic-capture] add rule failed:', err)
      res.status(500).json({ error: 'Failed to add capture rule' })
    }
  })

  router.put('/:profileId/rules/:ruleId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const profileId = idParam(req, 'profileId')
    const ruleId = idParam(req, 'ruleId')
    const parsed = RuleBody.safeParse(req.body)
    if (!profileId || !ruleId || !parsed.success || parsed.data.ruleOrder === undefined) {
      return void res.status(400).json({ error: 'Invalid input', detail: 'A full rule including ruleOrder is required' })
    }
    try {
      const rule = await opts.store.updateRule({
        actingUserId: req.userId!, workspaceId, profileId, ruleId, rule: parsed.data as CaptureRuleInput,
      })
      if (!rule) return void res.status(404).json({ error: 'Capture rule not found' })
      res.json({ rule })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return void res.status(409).json({ error: 'Rule order is already in use' })
      }
      console.error('[programmatic-capture] update rule failed:', err)
      res.status(500).json({ error: 'Failed to update capture rule' })
    }
  })

  router.delete('/:profileId/rules/:ruleId', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const profileId = idParam(req, 'profileId')
    const ruleId = idParam(req, 'ruleId')
    if (!profileId || !ruleId) return void res.status(404).json({ error: 'Capture rule not found' })
    const deleted = await opts.store.deleteRule({
      actingUserId: req.userId!, workspaceId, profileId, ruleId,
    })
    if (!deleted) return void res.status(404).json({ error: 'Capture rule not found' })
    res.status(204).end()
  })

  router.put('/assistants/:assistantId/default', async (req, res) => {
    const workspaceId = await gate(req, res)
    if (!workspaceId) return
    const assistantId = idParam(req, 'assistantId')
    const parsed = z.object({ profileId: Uuid.nullable() }).strict().safeParse(req.body)
    if (!assistantId || !parsed.success) return void res.status(400).json({ error: 'Invalid input' })
    const updated = await opts.store.setAssistantProfile({
      actingUserId: req.userId!, workspaceId, assistantId, profileId: parsed.data.profileId,
    })
    if (!updated) return void res.status(404).json({ error: 'Assistant or capture profile not found' })
    res.status(204).end()
  })

  return router
}
