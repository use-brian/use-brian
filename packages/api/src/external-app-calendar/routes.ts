/** Authenticated external-app calendar API. [COMP:api/external-app-outlook-calendar] */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../auth/middleware.js'
import type { AuthSessionStore } from '../db/auth-session-store.js'
import { CalendarError, CalendarReconcileInput, CalendarUpsertInput } from './client.js'
import { CalendarConfiguration, type createCalendarCredentials } from './credentials.js'

export function externalAppCalendarRoutes(options: {
  jwtSecret: string
  sessions?: Pick<AuthSessionStore, 'validateAccess'>
  withCalendar: ReturnType<typeof createCalendarCredentials>
}) {
  const router = Router()
  const paramsSchema = z.object({ workspaceId: z.string().uuid(), connectorInstanceId: z.string().uuid() })
  const correlationSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,200}$/)
  router.put('/workspaces/:workspaceId/outlook-calendar/:connectorInstanceId/configuration', requireAuth(options.jwtSecret, options.sessions), async (req, res) => {
    res.set('Cache-Control', 'private, no-store')
    const params = paramsSchema.safeParse(req.params), input = CalendarConfiguration.safeParse(req.body)
    const correlation = correlationSchema.safeParse(req.get('X-Correlation-ID'))
    if (!params.success || !input.success || !correlation.success || !req.userId) {
      res.status(400).json({ error: 'calendar_invalid_request', outcome: 'rejected' }); return
    }
    try {
      res.json(await options.withCalendar.configure({ ...params.data, userId: req.userId, correlationId: correlation.data }, input.data))
    } catch (error) {
      const failure = error instanceof CalendarError ? error : new CalendarError('calendar_dependency_unavailable')
      res.status(failure.status).json({ error: failure.code, outcome: failure.outcome, correlationId: correlation.data })
    }
  })
  for (const operation of ['upsert', 'reconcile'] as const) {
    router.post(`/workspaces/:workspaceId/outlook-calendar/:connectorInstanceId/events/${operation}`, requireAuth(options.jwtSecret, options.sessions), async (req, res) => {
      res.set('Cache-Control', 'private, no-store')
      const correlation = correlationSchema.safeParse(req.get('X-Correlation-ID'))
      const params = paramsSchema.safeParse(req.params)
      const input = (operation === 'upsert' ? CalendarUpsertInput : CalendarReconcileInput).safeParse(req.body)
      if (!correlation.success || !params.success || !input.success || !req.userId) {
        res.status(400).json({ error: 'calendar_invalid_request', outcome: 'rejected' }); return
      }
      const context = { ...params.data, userId: req.userId, correlationId: correlation.data }
      try {
        const result = await options.withCalendar(context, client => operation === 'upsert'
          ? client.upsert(CalendarUpsertInput.parse(input.data)) : client.reconcile(CalendarReconcileInput.parse(input.data)))
        console.info(JSON.stringify({ component: 'external-app-calendar', operation, ...context, status: result.status, providerId: result.event?.providerId }))
        res.status(result.status === 'created' ? 201 : 200).json(result)
      } catch (error) {
        const failure = error instanceof CalendarError ? error : new CalendarError('calendar_dependency_unavailable')
        console.warn(JSON.stringify({ component: 'external-app-calendar', operation, ...context, code: failure.code, outcome: failure.outcome }))
        if (failure.retryAfter && /^[0-9]{1,8}$/.test(failure.retryAfter)) res.set('Retry-After', failure.retryAfter)
        res.status(failure.status).json({ error: failure.code, outcome: failure.outcome, correlationId: context.correlationId })
      }
    })
  }
  return router
}
