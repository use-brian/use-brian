/**
 * Least-privilege public CRM intake route.
 *
 * This router owns authentication, byte/rate limits, and HTTP adaptation only.
 * The canonical service owns every semantic write and transaction step.
 * It must mount before broad `/api` JWT guards.
 *
 * [COMP:api/crm-intake-route]
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  CrmOperationsError,
  boundedCrmObject,
  createRateLimiter,
  type CrmOperationsServicePort,
} from '@use-brian/core'
import {
  parseCrmIntakeToken,
  type CrmIntakeReadStore,
} from '../db/crm-intake-store.js'

const BodySchema = z.object({
  fields: boundedCrmObject(1_048_576),
  externalIdentity: z.object({
    provider: z.string().trim().min(1).max(63),
    subject: z.string().trim().min(1).max(500),
  }).strict().optional(),
  submittedAt: z.string().datetime({ offset: true }).optional(),
}).strict()

type RateLimiter = ReturnType<typeof createRateLimiter>

export type CrmIntakeRouteOptions = {
  service: CrmOperationsServicePort
  readStore: CrmIntakeReadStore
  rateLimiter?: RateLimiter
}

function sourceIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']
  const head = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return req.ip ?? head?.split(',')[0]?.trim() ?? 'unknown'
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
}

function statusFor(error: CrmOperationsError): number {
  if (error.code === 'idempotency_conflict' || error.code === 'conflict') return 409
  if (error.code === 'payload_too_large') return 413
  if (error.code === 'not_authorized' || error.code === 'credential_revoked') return 401
  if (error.code === 'not_found') return 404
  return 400
}

export function crmIntakeRoutes(options: CrmIntakeRouteOptions): Router {
  const router = Router()
  const limiter = options.rateLimiter ?? createRateLimiter({ maxRequests: 60, windowMs: 60_000 })

  const preflightRateLimit = (req: Request, res: Response, next: NextFunction) => {
    const parsed = parseCrmIntakeToken(tokenFrom(req) ?? '')
    const candidate = parsed?.credentialId ?? 'invalid'
    limiter.middleware(req, res, next, () => `crm-intake:${candidate}:${sourceIp(req)}`)
  }

  router.post(
    '/crm/intake/:definitionKey/submissions',
    preflightRateLimit,
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const idempotencyKey = req.get('Idempotency-Key')?.trim()
      if (!idempotencyKey || idempotencyKey.length > 200) {
        res.status(400).json({ error: 'invalid_input', message: 'Idempotency-Key is required.' })
        return
      }
      const token = tokenFrom(req)
      const definitionKey = typeof req.params.definitionKey === 'string'
        ? req.params.definitionKey.trim().toLowerCase()
        : ''
      if (!token || !definitionKey) {
        res.status(401).json({ error: 'unauthorized' })
        return
      }
      const body = BodySchema.safeParse(req.body)
      if (!body.success) {
        res.status(400).json({ error: 'invalid_input', issues: body.error.issues })
        return
      }
      try {
        const principal = await options.readStore.authenticate(token, definitionKey)
        if (!principal) {
          res.status(401).json({ error: 'unauthorized' })
          return
        }
        const output = await options.service.execute({
          workspaceId: principal.workspaceId,
          actor: {
            kind: 'intake_key',
            credentialId: principal.credentialId,
            definitionId: principal.definitionId,
          },
          authority: {
            role: 'system', canWrite: true, canConfigure: false, trustedIdentitySources: [],
          },
          requestId: req.get('X-Request-Id') ?? undefined,
        }, {
          kind: 'record_submission',
          definitionKey: principal.definitionKey,
          idempotencyKey,
          ...body.data,
        })
        res.status(output.duplicate ? 200 : 201).json({
          submissionId: output.record.submissionId,
          contactId: output.record.contactId,
          followUpTaskId: output.record.followUpTaskId ?? null,
          duplicate: output.duplicate,
        })
      } catch (error) {
        if (error instanceof CrmOperationsError) {
          res.status(statusFor(error)).json({ error: error.code, message: error.message, ...error.details })
          return
        }
        console.error('[crm-intake] request failed', {
          definitionKey,
          requestId: req.get('X-Request-Id') ?? null,
          error: error instanceof Error ? error.message : 'unknown',
        })
        res.status(500).json({ error: 'internal' })
      }
    },
  )
  return router
}
