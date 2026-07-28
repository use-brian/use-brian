/**
 * Local-only ChatGPT subscription controls.
 *
 * Mounted only by the OSS composition and re-gated per request. Responses
 * contain masked account state, reviewed catalog metadata, or validated login
 * handoff data—never OAuth tokens or raw app-server payloads.
 *
 * [COMP:api/codex-provider]
 */
import { Router } from 'express'
import { z } from 'zod'
import type { CodexProviderManager } from '../codex-provider-manager.js'
import { isSelfHostedOssEnv } from './local-session.js'

const cancelSchema = z.object({
  loginId: z.string().min(1).max(256),
})
const preferenceSchema = z.object({
  preferredProvider: z.enum(['auto', 'gemini', 'openai-codex', 'dashscope-intl']),
})

export function codexProviderRoutes(
  manager: CodexProviderManager,
  isEnabled: () => boolean = isSelfHostedOssEnv,
): Router {
  const router = Router()

  router.use((_req, res, next) => {
    if (!isEnabled()) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    next()
  })

  router.get('/status', async (_req, res) => {
    try {
      res.json(await manager.status())
    } catch {
      res.status(503).json({ error: 'codex_runtime_unavailable' })
    }
  })

  router.post('/login/browser', async (_req, res) => {
    try {
      res.json(await manager.startBrowserLogin())
    } catch {
      res.status(503).json({ error: 'codex_login_unavailable' })
    }
  })

  router.post('/login/device', async (_req, res) => {
    try {
      res.json(await manager.startDeviceCodeLogin())
    } catch {
      res.status(503).json({ error: 'codex_login_unavailable' })
    }
  })

  router.post('/login/cancel', async (req, res) => {
    const parsed = cancelSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_login_id' })
      return
    }
    try {
      await manager.cancelLogin(parsed.data.loginId)
      res.json({ ok: true })
    } catch {
      res.status(503).json({ error: 'codex_login_unavailable' })
    }
  })

  router.post('/logout', async (_req, res) => {
    try {
      await manager.logout()
      res.json({ ok: true })
    } catch {
      res.status(503).json({ error: 'codex_logout_failed' })
    }
  })

  router.put('/preference', async (req, res) => {
    const parsed = preferenceSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_preferred_provider' })
      return
    }
    try {
      await manager.setPreferredProvider(parsed.data.preferredProvider)
      res.json({ preferredProvider: parsed.data.preferredProvider })
    } catch {
      res.status(500).json({ error: 'preferred_provider_save_failed' })
    }
  })

  return router
}
