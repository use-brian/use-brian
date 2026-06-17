/**
 * Workflow webhook receiver — unauthenticated public endpoint that
 * accepts a payload, verifies an HMAC signature against the workflow's
 * `webhook_secret`, and kicks off a workflow run.
 *
 * Mounted at `/api/workflow-webhooks/:slug` in `apps/api/src/index.ts`.
 * Auth model: HMAC-SHA256 over the raw request body in header
 * `X-Workflow-Signature: sha256=<hex>`. Caller supplies the body; we
 * compare timing-safe against `hmac(webhook_secret, body)`.
 *
 * The sender becomes `workflow.created_by` for billing/audit. The body
 * is parsed as JSON and made available to steps as `{{input.X}}`. Non-
 * JSON bodies are accepted as `{ rawBody: string }`.
 *
 * Spec: `docs/plans/company-brain/workflow-builder.md`.
 *
 * [COMP:api/workflow-webhooks-route]
 */

import { Router, raw } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  advanceWorkflowRun,
  type ExecutorDeps,
  type WorkflowRunStore,
  type WorkflowStore,
} from '@sidanclaw/core'

export type WorkflowWebhookRouteOptions = {
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  runDeps: ExecutorDeps
}

const SIGNATURE_HEADER = 'x-workflow-signature'

function verifySignature(body: Buffer, secret: string, header: string | undefined): boolean {
  if (!header) return false
  const match = /^sha256=([0-9a-f]+)$/i.exec(header)
  if (!match) return false
  const provided = Buffer.from(match[1], 'hex')
  const expected = createHmac('sha256', secret).update(body).digest()
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

function tryParseJson(buf: Buffer): Record<string, unknown> {
  try {
    const txt = buf.toString('utf8')
    if (!txt) return {}
    const parsed = JSON.parse(txt)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { rawBody: buf.toString('utf8') }
  }
}

export function workflowWebhookRoutes(opts: WorkflowWebhookRouteOptions): Router {
  const router = Router()

  // Use a raw body parser locally because this route mounts before the
  // global `express.json()` and we need the exact bytes for HMAC.
  router.post('/workflow-webhooks/:slug', raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const slug = req.params.slug
    const workflow = await opts.workflowStore.findByWebhookSlugSystem(slug)
    if (!workflow || workflow.trigger.kind !== 'webhook' || !workflow.webhookSecret) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }

    const sigHeader = req.header(SIGNATURE_HEADER)
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (!verifySignature(body, workflow.webhookSecret, sigHeader)) {
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    if (!workflow.enabled) {
      res.status(409).json({ error: 'Workflow disabled' })
      return
    }

    const input = tryParseJson(body)

    const run = await opts.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      // Webhook fires without a user — fall back to the creator for
      // billing/auth (same pattern as scheduled triggers).
      triggeredBy: workflow.createdBy,
      triggerKind: 'manual',
      input,
    })

    const outcome = await advanceWorkflowRun(opts.runDeps, run.id)

    res.json({
      runId: outcome.runId,
      status:
        outcome.kind === 'completed'
          ? 'completed'
          : outcome.kind === 'failed'
            ? 'failed'
            : outcome.reason === 'wait'
              ? 'awaiting_wait'
              : 'awaiting_input',
      error: outcome.kind === 'failed' ? outcome.error : null,
    })
  })

  return router
}
