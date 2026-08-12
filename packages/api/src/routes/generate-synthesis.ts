/**
 * User-initiated Generate from Brain route.
 *
 * The synthesis behavior is open and mounted by bootOpenApi for both editions.
 * Hosted pricing and surcharge persistence arrive through optional billing
 * hooks; self-hosted OSS confirms the long-running operation but charges zero.
 *
 * [COMP:api/generate-route]
 */
import { Router } from 'express'
import { z } from 'zod'

import { getWorkspacePlan } from '../db/workspace-store.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'
import type { GenerateSynthesizeFn } from '../synthesis/generate-synthesizer.js'
import type { CreditBudgetGate } from './route-helpers.js'

export type GenerateSynthesisCharge = {
  workspaceId: string
  requestId: string
  credits: number
  blueprintId: string
  pageId: string | null
  subject: string
  sectionCount: number
  chargedByUserId: string
}

export type GenerateSynthesisBilling = {
  quoteCredits: (sectionCount: number) => number
  charge: (input: GenerateSynthesisCharge) => Promise<unknown>
}

export type GenerateSynthesisRouteDeps = {
  getRole: (userId: string, workspaceId: string) => Promise<string | null>
  generateSynthesize?: GenerateSynthesizeFn
  resolvePrimaryAssistantForWorkspace: (workspaceId: string) => Promise<string | null>
  pageTemplateStore: Pick<PageTemplateStore, 'getById'>
  checkCreditBudget?: CreditBudgetGate
  billing?: GenerateSynthesisBilling
}

const generateInputSchema = z.object({
  subject: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  sensitivity: z.string().optional(),
})

export function generateSynthesisRoutes(deps: GenerateSynthesisRouteDeps): Router {
  const router = Router({ mergeParams: true })

  router.post('/:blueprintId/estimate', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { workspaceId, blueprintId } = req.params as { workspaceId: string; blueprintId: string }
    if (!(await deps.getRole(userId, workspaceId))) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }

    const template = await deps.pageTemplateStore.getById(userId, blueprintId)
    if (!template || template.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Blueprint not found' })
      return
    }
    if (!template.extraction) {
      res.status(400).json({ error: 'not_a_blueprint', detail: 'This template has no extraction spec.' })
      return
    }

    const sectionCount = template.extraction.fields.length
    res.json({
      blueprintId,
      name: template.name,
      sectionCount,
      surchargeCredits: deps.billing?.quoteCredits(sectionCount) ?? 0,
    })
  })

  router.post('/:blueprintId/generate', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const parsed = generateInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    const { workspaceId, blueprintId } = req.params as { workspaceId: string; blueprintId: string }
    if (!(await deps.getRole(userId, workspaceId))) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }
    if (!deps.generateSynthesize) {
      res.status(503).json({ error: 'generation_unavailable', detail: 'No model key configured.' })
      return
    }

    const template = await deps.pageTemplateStore.getById(userId, blueprintId)
    if (!template || template.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Blueprint not found' })
      return
    }
    if (!template.extraction) {
      res.status(400).json({ error: 'not_a_blueprint' })
      return
    }

    const sectionCount = template.extraction.fields.length
    const credits = deps.billing?.quoteCredits(sectionCount) ?? 0

    if (deps.checkCreditBudget) {
      const plan = await getWorkspacePlan(workspaceId)
      const gate = await deps.checkCreditBudget(workspaceId, plan)
      if (gate.status === 'blocked') {
        res.status(402).json({
          error: 'credit_limit',
          creditsUsed: gate.creditsUsed,
          creditCap: gate.creditCap,
          resetsAt: gate.resetsAt,
        })
        return
      }
    }

    const assistantId = await deps.resolvePrimaryAssistantForWorkspace(workspaceId)
    if (!assistantId) {
      res.status(409).json({
        error: 'no_assistant',
        detail: 'Workspace has no assistant to attribute the run to.',
      })
      return
    }

    const { subject, requestId, sensitivity } = parsed.data
    const result = await deps.generateSynthesize({
      blueprintSlug: blueprintId,
      subject,
      workspaceId,
      userId,
      assistantId,
      sensitivity: sensitivity?.trim() || undefined,
    })
    if (!result) {
      res.status(422).json({ error: 'blueprint_unresolved' })
      return
    }

    if (deps.billing) {
      try {
        await deps.billing.charge({
          workspaceId,
          requestId,
          credits,
          blueprintId,
          pageId: result.pageId,
          subject,
          sectionCount,
          chargedByUserId: userId,
        })
      } catch (err) {
        console.error('[generate-synthesis] surcharge charge failed (page kept):', err)
      }
    }

    res.json({ pageId: result.pageId, chargedCredits: credits })
  })

  return router
}
