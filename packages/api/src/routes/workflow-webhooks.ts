/**
 * Workflow webhook receiver — unauthenticated public endpoint that
 * accepts a payload, verifies an HMAC signature against the workflow's
 * `webhook_secret`, and kicks off a workflow run.
 *
 * Mounted PUBLIC in `boot.ts` — BEFORE the bare `app.use('/api',
 * requireAuth(...))` guards. Express runs path-prefix middleware in
 * registration order, so a webhook route registered after the first bare
 * `/api` guard is 401'd before its handler runs (the shadowing bug fixed
 * 2026-06-30). External senders carry `X-Workflow-Signature`, never a Bearer
 * token, so they can never satisfy `requireAuth`.
 *
 * Auth model: HMAC-SHA256 over the raw request body in header
 * `X-Workflow-Signature: sha256=<hex>`. Caller supplies the body; we
 * compare timing-safe against `hmac(webhook_secret, body)`. The exact bytes
 * come from `req.rawBody` (stashed by the global `express.json()` `verify`
 * hook for `application/json`) or the route-level `raw()` Buffer otherwise —
 * never from the parsed object, whose key order would not re-serialize to the
 * signed bytes.
 *
 * The sender becomes `workflow.created_by` for billing/audit. The body is
 * parsed as JSON and made available to steps as `{{input.X}}`. Non-JSON bodies
 * are accepted as `{ rawBody: string }`. An optional `trigger.match.condition`
 * (JSONLogic over the parsed payload) lets one slug react to only specific
 * events: a non-matching delivery is ACKed 200 without starting a run.
 *
 * Spec: `docs/plans/company-brain/workflow-builder.md`.
 *
 * [COMP:api/workflow-webhooks-route]
 */

import { Router, raw } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  advanceWorkflowRun,
  evaluateBoolean,
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
    // The global `express.json()` consumes the stream for `application/json`
    // and stashes the exact bytes on `req.rawBody` (string) via its `verify`
    // hook; the route-level `raw()` parser is then skipped, so `req.body` is the
    // parsed OBJECT, not a Buffer. HMAC must run over the original bytes, so
    // prefer `req.rawBody`; fall back to the Buffer for non-JSON content types.
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody
    const body =
      typeof rawBody === 'string'
        ? Buffer.from(rawBody, 'utf8')
        : Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.alloc(0)
    if (!verifySignature(body, workflow.webhookSecret, sigHeader)) {
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    if (!workflow.enabled) {
      res.status(409).json({ error: 'Workflow disabled' })
      return
    }

    const input = tryParseJson(body)

    // Optional server-side event filter. `match.condition` is JSONLogic
    // evaluated against `{ input }` (same engine as the `branch` step). A falsy
    // result ACKs 200 without starting a run; a malformed condition fails CLOSED
    // (no run) and is reported — it never 500s the receiver.
    const match = workflow.trigger.kind === 'webhook' ? workflow.trigger.match : undefined
    if (match) {
      let fires: boolean
      try {
        fires = evaluateBoolean(match.condition, { input })
      } catch (err) {
        res.status(200).json({
          runId: null,
          status: 'skipped',
          reason: 'filter_error',
          error: err instanceof Error ? err.message : String(err),
        })
        return
      }
      if (!fires) {
        res.status(200).json({ runId: null, status: 'skipped', reason: 'no_match' })
        return
      }
    }

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
