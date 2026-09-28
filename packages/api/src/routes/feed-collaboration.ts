import {createLinkedInPromotion,completeLinkedInManual,readLinkedInManualReceipt,linkedinManualCommand} from '../content-planning/linkedin-newsletter.js'
import { readLinkedInPreview } from '../content-planning/linkedin-payload.js'
import { readFeedSelectedSources } from '../content-planning/source-authority.js'
import type { FeedReviewContextLoader } from '../content-planning/review-context.js'
/** Authenticated shared Feed collaboration routes. [COMP:feed/draft-comments] */
import { exportFeedArticle, feedOutputProjection } from '../content-planning/projection.js'
import { readFeedCopy, requireFeedComposition } from '../db/feed-collaboration-store.js'
import type { FilesApi } from '@use-brian/core'
import type { FeedGenerationService } from '../content-planning/generation.js'
import { Router } from 'express'
import { z } from 'zod'
import { feedCommandRequestSchema, feedReviewRequestSchema, feedGenerationEstimateRequestSchema, feedGenerationRequestSchema, feedConfirmationRequestSchema, feedLearningCommandRequestSchema } from '@use-brian/shared'
import { feedCommand, readReviewedFeedCollaboration } from '../content-planning/collaboration-service.js'
import { getFeedThreadMessages, FeedCollaborationError, withFeedTransaction, type FeedActor } from '../db/feed-collaboration-store.js'
import { requestFeedReview } from '../content-planning/review.js'
import { confirmFeedPost } from '../content-planning/confirmation.js'
import { executeFeedLearningCommand, readFeedLearnedDecisions } from '../content-planning/learning.js'
import { getFeedRun, summarizeFeedRun, cancelFeedRun, retryFeedRun } from '../db/feed-editorial-runs-store.js'
const uuid = z.string().uuid()
export function feedCollaborationRoutes(options: { generation?: FeedGenerationService; reviewContext?: FeedReviewContextLoader; files?: FilesApi } = {}): Router {
  const router = Router(); const base = '/:assistantId/draft-sessions/:sessionId'
  router.all(`${base}/{*rest}`, async (req, res, next) => {
    if (!req.userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (!uuid.safeParse(req.params.assistantId).success || !uuid.safeParse(req.params.sessionId).success) { res.status(400).json({ error: 'Invalid draft identity' }); return }
    next()
  })
  router.get(`${base}/sources`, async (req, res) => {
    try {
      const kind = z.enum(['file', 'memory']).parse(req.query.kind)
      const actor: FeedActor = { userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }
      const sources = await withFeedTransaction(actor, (client, scope) => readFeedSelectedSources(client, actor, scope, kind, null), false)
      res.json({ sources: sources.map(({ id, name, sensitivity }) => ({ id, name, sensitivity })) })
    } catch (error) { replyError(res, error) }
  })
  router.get(`${base}/collaboration`, async (req, res) => {
    try { res.json(await readReviewedFeedCollaboration({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, options.reviewContext)) }
    catch (error) { replyError(res, error) }
  })
  router.post(`${base}/commands`, async (req, res) => {
    try {
      const actor: FeedActor = { userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }
      const receipt = await feedCommand(actor, feedCommandRequestSchema.parse(req.body))
      const copy = await withFeedTransaction(actor, client => readFeedCopy(client, actor.sessionId), false)
      res.json({ receipt, sourceSensitivity: copy?.content.sourceSensitivity, sourceAuthority: { sourceFileIds: copy?.content.sourceFileIds, sourceMemoryIds: copy?.content.sourceMemoryIds, sourceCompartments: copy?.content.sourceCompartments, sourceProjectIds: copy?.content.sourceProjectIds } })
    }
    catch (error) { replyError(res, error) }
  })
  router.post(`${base}/linkedin-promotion`,async(req,res)=>{try{const input=z.object({expectedRevision:z.number().int().nonnegative(),sessionId:uuid}).strict().parse(req.body);res.json(await createLinkedInPromotion({userId:req.userId!,assistantId:req.params.assistantId,sessionId:req.params.sessionId,kind:'user'},input.expectedRevision,input.sessionId))}catch(error){replyError(res,error)}})
  router.get(`${base}/linkedin-receipt`,async(req,res)=>{try{res.json({receipt:await readLinkedInManualReceipt({userId:req.userId!,assistantId:req.params.assistantId,sessionId:req.params.sessionId,kind:'user'})??null})}catch(error){replyError(res,error)}})
  router.post(`${base}/linkedin-published`,async(req,res)=>{try{res.json({receipt:await completeLinkedInManual({userId:req.userId!,assistantId:req.params.assistantId,sessionId:req.params.sessionId,kind:'user'},linkedinManualCommand.parse(req.body))})}catch(error){replyError(res,error)}})
  router.get(`${base}/learning`, async (req, res) => {
    try { res.json(await readFeedLearnedDecisions({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' })) }
    catch (error) { replyError(res, error) }
  })
  router.post(`${base}/confirmation`, async (req, res) => {
    try {
      const result = await confirmFeedPost({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, feedConfirmationRequestSchema.parse(req.body))
      res.json({ confirmationId: result.confirmation.id, revision: result.confirmation.revision, runId: result.runId })
    } catch (error) { replyError(res, error) }
  })
  router.post(`${base}/learning/commands`, async (req, res) => {
    try { res.json({ receipt: await executeFeedLearningCommand({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, feedLearningCommandRequestSchema.parse(req.body)) }) }
    catch (error) { replyError(res, error) }
  })
  router.get(`${base}/threads/:threadId/messages`, async (req, res) => {
    try {
      const before = z.coerce.number().int().positive().max(2_000_000_000).parse(req.query.before ?? 2_000_000_000)
      res.json({ messages: await getFeedThreadMessages({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, uuid.parse(req.params.threadId), before) })
    } catch (error) { replyError(res, error) }
  })
  router.get(`${base}/history`, async (req, res) => {
    try {
      const actor: FeedActor = { userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }
      const before = z.coerce.number().int().positive().max(2_000_000_000).parse(req.query.before ?? 2_000_000_000)
      const revisions = await withFeedTransaction(actor, async client => (await client.query(`SELECT revision,actor_user_id AS "actorUserId",actor_kind AS "actorKind",content,forward_commands AS commands,created_at AS "createdAt" FROM feed_post_revisions WHERE session_id=$1 AND revision<$2 ORDER BY revision DESC LIMIT 30`, [actor.sessionId, before])).rows, false)
      res.json({ revisions, nextBefore: revisions.length === 30 ? revisions.at(-1)!.revision : null })
    } catch (error) { replyError(res, error) }
  })
  router.post(`${base}/reviews`, async (req, res) => {
    try { res.json({ run: summarizeFeedRun(await requestFeedReview({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, feedReviewRequestSchema.parse(req.body), options.reviewContext)) }) }
    catch (error) { replyError(res, error) }
  })
  router.post(`${base}/generations/estimate`, async (req, res) => {
    try {
      if (!options.generation) throw new FeedCollaborationError(503, 'generation_unavailable')
      res.json({ estimate: await options.generation.estimate({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, feedGenerationEstimateRequestSchema.parse(req.body)) })
    } catch (error) { replyError(res, error) }
  })
  router.post(`${base}/generations`, async (req, res) => {
    try {
      if (!options.generation) throw new FeedCollaborationError(503, 'generation_unavailable')
      res.json({ run: summarizeFeedRun(await options.generation.dispatch({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, feedGenerationRequestSchema.parse(req.body))) })
    } catch (error) { replyError(res, error) }
  })
  router.get(`${base}/runs/:runId`, async (req, res) => {
    try { res.json({ run: summarizeFeedRun(await getFeedRun({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, uuid.parse(req.params.runId))) }) }
    catch (error) { replyError(res, error) }
  })
  router.post(`${base}/runs/:runId/:action`, async (req, res) => {
    try {
      const action = z.enum(['cancel', 'retry']).parse(req.params.action)
      const actor: FeedActor = { userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }
      res.json({ run: summarizeFeedRun(await (action === 'cancel' ? cancelFeedRun : retryFeedRun)(actor, uuid.parse(req.params.runId))) })
    } catch (error) { replyError(res, error) }
  })
  router.get(`${base}/projection`, async (req, res) => {
    try {
      const actor: FeedActor = { userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }
      res.json(await withFeedTransaction(actor, async client => { const copy = await readFeedCopy(client, actor.sessionId); if (!copy) throw new FeedCollaborationError(404, 'working_copy_required'); const session = (await client.query('SELECT title FROM sessions WHERE id=$1', [actor.sessionId])).rows[0]; return { revision: copy.revision, ...feedOutputProjection(requireFeedComposition(copy.content), /^\[([^\]]+)\]/.exec(session.title)?.[1] ?? 'threads') } }, false))
    } catch (error) { replyError(res, error) }
  })
  router.get(`${base}/linkedin-preview`, async (req, res) => {
    try { res.json(await readLinkedInPreview({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, z.coerce.number().int().nonnegative().parse(req.query.revision))) }
    catch (error) { replyError(res, error) }
  })
  router.post(`${base}/export`, async (req, res) => {
    try {
      const input = z.object({ expectedRevision: z.number().int().nonnegative(), acknowledgeOmissions: z.boolean().default(false) }).strict().parse(req.body)
      const archive = await exportFeedArticle({ userId: req.userId!, assistantId: req.params.assistantId, sessionId: req.params.sessionId, kind: 'user' }, input.expectedRevision, input.acknowledgeOmissions, options.files)
      res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', 'attachment; filename="feed-article.zip"'); res.send(archive)
    } catch (error) { replyError(res, error) }
  })
  return router
}
function replyError(res: import('express').Response, error: unknown) {
  if (error instanceof FeedCollaborationError) res.status(error.status).json({ error: error.code, code: error.code })
  else if (error instanceof z.ZodError) res.status(400).json({ error: 'Invalid Feed request', code: 'invalid_request' })
  else { console.error('[feed-collaboration] request failed', error); res.status(500).json({ error: 'Draft collaboration unavailable', code: 'collaboration_unavailable' }) }
}
