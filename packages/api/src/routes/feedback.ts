import { Router } from 'express'
import { resolveUser } from './route-helpers.js'
import { recordFeedback } from '../feedback/record.js'

/**
 * POST /api/feedback
 *
 * Web-chat surface — the thumbs-up/down icons on assistant messages
 * funnel through here. Slack and Telegram do NOT hit this route;
 * their reaction handlers call `recordFeedback()` directly (see
 * `routes/slack.ts` → reaction_added, `routes/telegram.ts` →
 * message_reaction).
 *
 * Body: { messageId, sessionId, kind: 'positive' | 'negative', issueType?, details? }
 *
 * Spec: docs/architecture/brain/corrections.md → "Feedback signal".
 */
export function feedbackRoutes(): Router {
  const router = Router()

  router.post('/', async (req, res) => {
    const { messageId, sessionId, kind, issueType, details } = req.body as {
      messageId?: string
      sessionId?: string
      kind?: 'positive' | 'negative'
      issueType?: string
      details?: string
    }

    if (!messageId || !kind || (kind !== 'positive' && kind !== 'negative')) {
      res.status(400).json({ error: 'Missing or invalid fields' })
      return
    }

    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.status(401).json({ error: 'User not found' }); return }

      await recordFeedback({
        userId: user.id,
        messageId,
        sessionId: sessionId ?? null,
        kind,
        issueType,
        details,
        source: 'web',
      })

      res.json({ ok: true })
    } catch (err) {
      console.error('Feedback error:', err)
      res.status(500).json({ error: 'Failed to save feedback' })
    }
  })

  return router
}
