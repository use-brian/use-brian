/**
 * Workflow channel delivery — pushes an `assistant_call` step's text output
 * to a user channel. The execution-side counterpart of the
 * `assistant_call.deliver` step field.
 *
 * Reuses the per-channel adapter path the scheduled-job executor uses
 * (`packages/api/src/scheduling/executor.ts`): Telegram BYO token → shared
 * default, Slack BYO, WhatsApp connector. DB-first — the message is
 * persisted into the messaging-channel delivery session before the push, so
 * a failed push still surfaces in that channel's history.
 *
 * Web is NOT a delivery target: the web UI is a pull surface, so a scheduled
 * / workflow push there only landed an unsolicited message in the user's main
 * chat thread. `web` deliveries are dropped here (a no-op) — scheduled output
 * goes to a messaging channel or, for a doc-maintaining job, updates the
 * page in place (the one-step reminder workflow omits `deliver` entirely).
 * Legacy jobs whose stored `deliver.channelType` is still 'web' become silent
 * no-ops on their next fire.
 *
 * This bridges the scheduling ⇄ workflow gap — it gives a one-step workflow
 * the channel-delivery capability a scheduled job has.
 *
 * Spec: docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
 *
 * [COMP:workflow/channel-delivery]
 */

import { createWorkflowPublicationAuthorizer, createWorkflowPublicationDispatcher, type AuthorizeWorkflowPublication, type DispatchWorkflowPublication } from './publication-consent.js'
import { createChannelQuestionStore, workflowQuestionActions, workflowQuestionReplyHint, type ChannelQuestionStore } from './channel-questions.js'
import type { DeliverToChannel, DeliveryOutcome } from '@use-brian/core/workflow/executor.js'
import { formatAssistantQuestion } from '@use-brian/agent-runtime/tools/base/ask-question.js'
import { resolveWriteScope, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { DerivedScopeError } from '@use-brian/agent-runtime/security/derived-scope.js'
import { maxSensitivity, type Sensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import { sanitizeDeliveryText } from '@use-brian/shared'
import {
  createSlackAdapter,
  createTelegramAdapter,
  createWhatsAppAdapter,
  createWhatsAppCloudAdapter,
  createMsTeamsAdapter,
  createFeishuAdapter,
  createCustomAdapter,
  describeSlackError,
  isSlackApiError,
} from '@use-brian/channels'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { CustomChannelStore } from '../db/custom-channel-store.js'
import { findOrCreateSession, addSessionMessage, setSessionMessageChannelId, type Session } from '../db/sessions.js'
import { findRoomDeliveryAddress, findRoomForDelivery } from '../channel-room/room.js'
import { getPool, query } from '../db/client.js'
import { conversationAnchorWriteAdmissionActive } from '../db/conversation-visibility.js'
import { sessionKindSql } from '../session-kind.js'
import { whatsappCloudUserAllowed } from '../whatsapp/cloud-access.js'
import { createFeishuApi } from '../feishu/client.js'
import type { FeishuCredentials } from '../db/channel-integrations.js'
import {
  createDeliveryAudienceAuthorizer,
  resolveGroupAudienceSystem,
  type AuthorizeDeliveryAudience,
  type DeliveryAudienceInput,
} from '../context-scope/delivery-authority.js'
import type { PoolClient } from 'pg'

export type WorkflowChannelDeliveryOptions = {
  questionStore?: ChannelQuestionStore
  /** BYO Telegram + Slack credentials. */
  integrationStore?: ChannelIntegrationStore
  /** Shared official Telegram bot — fallback when an assistant has no BYO row. */
  defaultTelegramBotToken?: string
  /** WhatsApp delivery via the wa-connector. */
  waConnectorUrl?: string
  waConnectorSecret?: string
  /** Injectable clock for customer-service-window checks. */
  now?: () => number
  /**
   * Custom (bridge-driven) channel outbox. A custom delivery enqueues a
   * `message` item on the workspace channel for the bridge to pull
   * (docs/architecture/channels/custom-channel.md).
   */
  customChannelStore?: Pick<CustomChannelStore, 'enqueue'>
  /** Injectable final-sink policy; production defaults to live authority. */
  authorizeDeliveryAudience?: AuthorizeDeliveryAudience
  authorizeWorkflowPublication?: AuthorizeWorkflowPublication
  dispatchWorkflowPublication?: DispatchWorkflowPublication
}

type SlackDeliveryReceipt = NonNullable<Extract<DeliveryOutcome, { status: 'failed' }>['receipt']>
class DeliveryAudienceWithdrawn extends Error {}

// Narrow, known no-effect rejections. Unknown/provider-internal/transport errors
// remain uncertain, even when they happen on the first chunk.
// https://docs.slack.dev/reference/methods/chat.postMessage/#errors
const SLACK_NO_EFFECT_REJECTIONS = new Set([
  'channel_not_found', 'not_in_channel', 'missing_scope', 'invalid_auth',
  'not_authed', 'is_archived', 'no_text', 'no_permission',
])

function slackDeliveryFailure(err: unknown, receipt: SlackDeliveryReceipt, threadRef?: string): string {
  const where = threadRef
    ? `Slack channel \`${receipt.channelId}\` (as a reply in thread \`${threadRef}\`)`
    : `Slack channel \`${receipt.channelId}\``
  if (receipt.effect === 'none') {
    const diagnosis = isSlackApiError(err) ? describeSlackError(err)
      : 'Delivery preparation failed before the provider send started.'
    return `Slack delivery failed: no message was posted to ${where}. ${diagnosis} This attempt is safe to retry after correcting the cause and rechecking current authority. Do not tell the user it was sent.`
  }
  const state = receipt.effect === 'complete'
    ? 'Slack acknowledged the delivery, but local delivery bookkeeping failed.'
    : receipt.effect === 'partial'
      ? `Slack delivery is partial: ${receipt.messageIds.length} message(s) were acknowledged.`
      : 'Slack delivery is unconfirmed; messages may already have been posted.'
  // Never reuse describeSlackError here: its per-call remedy cannot account for
  // an earlier accepted chunk and may advise repeating an uncertain write.
  return `${state} Check ${where} and the saved delivery receipt before taking further action. Do not resend the full output: it could duplicate messages. Do not report complete delivery until reconciled.`
}

export function createWorkflowChannelDelivery(
  options: WorkflowChannelDeliveryOptions,
): DeliverToChannel {
  const deliver = createDelivery(options)
  return async (args) => {
    let persistedRowId: string | undefined
    const outcome = await deliver(args, (id) => { persistedRowId = id })
    // The room's transcript carries the provider id of what was posted, so a
    // reply to it resolves like a reply to any other group message.
    if (outcome.status === 'delivered' && outcome.messageId && persistedRowId) {
      await setSessionMessageChannelId(persistedRowId, outcome.messageId).catch((err: unknown) => {
        console.warn('[workflow-delivery] provider message id not recorded:', err)
      })
    }
    return outcome
  }
}

/**
 * The session a delivery is persisted into: the group's room when the group
 * converged (§4.4), else the per-user delivery session.
 */
async function deliverySession(params: {
  workspaceId: string; assistantId: string; userId: string; channelType: string; channelId: string
}): Promise<Pick<Session,'id'|'anchorKind'>> {
  const room = conversationAnchorWriteAdmissionActive() ? await findRoomDeliveryAddress(params) : await findRoomForDelivery(params)
  return room ?? findOrCreateSession({
    assistantId: params.assistantId,
    userId: params.userId,
    channelType: params.channelType,
    channelId: params.channelId,
  })
}

type DeliveryEnvelope = {
  version: string
  visibility: 'workspace' | 'configured_private' | 'private_by_kind'
  cap: Sensitivity
  compartments: string[]
  projects: string[]
}

async function readDeliveryEnvelope(input: DeliveryAudienceInput, sessionId: string,
  write?: { client:PoolClient; shared:boolean }): Promise<DeliveryEnvelope | undefined> {
  const client=write?.client
  if (client && !write?.shared) {
    const pin = await client.query<{ allowed:boolean }>('SELECT public.lock_conversation_member_read($1,$2,$3) AS allowed',
      [input.workspaceId,sessionId,input.userId])
    if (pin.rows[0]?.allowed!==true) return undefined
  }
  const statement = `SELECT e.version::text AS version,e.visibility,e.cap,e.compartments,
    public.conversation_hard_project_ids(e.compartments) AS projects
    FROM public.conversation_envelopes e JOIN public.sessions s ON s.id=e.session_id
    JOIN public.assistants sender ON sender.id=$3 AND sender.workspace_id=e.workspace_id
    ${write?.shared ? 'JOIN public.workspace_members actor ON actor.workspace_id=e.workspace_id AND actor.user_id=$4' : ''}
    WHERE e.session_id=$1 AND e.workspace_id=$2 AND s.channel_type=$5 AND s.channel_id=$6
      AND (s.anchor_kind='channel' AND s.archived_at IS NULL AND e.visibility='workspace'
       AND (s.provider_context_identity IS NULL OR s.provider_context_identity->>'integrationId'=$7)
       OR s.anchor_kind='none' AND s.assistant_id=$3 AND e.starter_user_id=$4 AND e.visibility<>'workspace'
       AND NOT EXISTS(SELECT 1 FROM public.sessions room WHERE room.workspace_id=e.workspace_id
        AND room.channel_type=$5 AND room.channel_id=$6 AND ${sessionKindSql.channelRoomDeliveryAddress('room')}))
      ${!client ? 'AND public.conversation_member_read_allowed(e.workspace_id,e.session_id,$4)'
        : write?.shared ? "AND s.anchor_kind='channel' FOR SHARE OF s,e,actor" : ''}`
  const args = [sessionId,input.workspaceId,input.assistantId,input.userId,input.channelType,input.channelId,input.channelIntegrationId ?? null]
  const result = client ? await client.query<DeliveryEnvelope>(statement,args) : await query<DeliveryEnvelope>(statement,args)
  return result.rows[0]
}

async function persistDeliveryMessage(input: DeliveryAudienceInput, session: Pick<Session,'id'|'anchorKind'>, text: string, evidence: ScopeEvidence | undefined) {
  const sessionId=session.id
  const message = { sessionId,role:'assistant',content:[{type:'text',text}],senderAssistantId:input.assistantId }
  const derivation = evidence?.sources?.length ? { producer:'delivery:workflow',sources:evidence.sources } : undefined
  if (!conversationAnchorWriteAdmissionActive()) return { message:await addSessionMessage({...message,derivation}),version:null }
  if (!evidence) return null
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT id FROM public.workspaces WHERE id=$1 FOR UPDATE',[input.workspaceId])
    const shared=session.anchorKind==='channel'
    const envelope = await readDeliveryEnvelope(input,sessionId,{client,shared})
    if (!envelope) { await client.query('ROLLBACK'); return null }
    // The destination pin holds a SHARE lock for its authority proof. Serialize
    // actual sequence allocation with other append owners before writing.
    await client.query('SELECT id FROM public.sessions WHERE id=$1 FOR UPDATE',[sessionId])
    const floor = resolveWriteScope({evidence})
    if (maxSensitivity(floor.sensitivity,envelope.cap)!==envelope.cap
      || floor.compartments.some(label=>!envelope.compartments.includes(label))
      || floor.projectIds.some(project=>!envelope.projects.includes(project))) {
      await client.query('ROLLBACK'); return null
    }
    if (shared) {
      if (envelope.projects.length) {
        await client.query(`SELECT project_id FROM public.project_shared_scopes WHERE workspace_id=$1
          AND project_id=ANY($2::uuid[]) ORDER BY project_id FOR SHARE`,[input.workspaceId,envelope.projects])
        await client.query(`SELECT project_id FROM public.project_shared_members WHERE user_id=$1
          AND project_id=ANY($2::uuid[]) ORDER BY project_id FOR SHARE`,[input.userId,envelope.projects])
      }
      const current=(await client.query<{allowed:boolean}>('SELECT public.conversation_member_read_allowed($1,$2,$3) AS allowed',
        [input.workspaceId,sessionId,input.userId])).rows[0]?.allowed
      const audience=await resolveGroupAudienceSystem(input,client)
      if (!current || !audience.allowed || maxSensitivity(floor.sensitivity,audience.ceiling.clearance)!==audience.ceiling.clearance
        || audience.ceiling.compartments!==null && floor.compartments.some(label=>!audience.ceiling.compartments?.includes(label))
        || audience.ceiling.projectIds!==null && floor.projectIds.some(project=>!audience.ceiling.projectIds?.includes(project))) {
        await client.query('ROLLBACK'); return null
      }
    }
    const scope = { workspaceId:input.workspaceId,userId:envelope.visibility==='workspace' ? null : input.userId,
      assistantId:null,...floor }
    const saved = await addSessionMessage(derivation ? {...message,derivation,derivationTarget:scope} : {...message,scope},client)
    if ((await client.query('SELECT 1 FROM public.conversation_message_quarantine WHERE message_id=$1',[saved.id])).rows.length) {
      await client.query('ROLLBACK'); return null
    }
    await client.query('COMMIT')
    return { message:saved,version:envelope.version }
  } catch(error) {
    await client.query('ROLLBACK')
    if (error instanceof DerivedScopeError || (error as {code?:string}).code==='42501') return null
    throw error
  } finally { client.release() }
}

function createDelivery(
  options: WorkflowChannelDeliveryOptions,
): (args: Parameters<DeliverToChannel>[0], onPersisted: (rowId: string) => void) => Promise<DeliveryOutcome> {
  return async ({
    workspaceId,
    assistantId,
    userId,
    channelType,
    channelId,
    channelIntegrationId,
    text,
    actions,
    scopeEvidence,
    publication,
    question,
    questionResponse,
    threadRef,
    replyToTrigger,
  }, onPersisted): Promise<DeliveryOutcome> => {
    // Strip any model scaffolding / meta-commentary before it is persisted to
    // the delivery session OR pushed to the channel — a cron-framed turn can
    // echo a "Message body:" planning preamble and a duplicated body (see
    // sanitizeDeliveryText). Idempotent: the core executor already sanitized
    // for the workflow path; this defends every DeliverToChannel caller.
    // Buttons are an optional adapter enhancement, never the only representation.
    // Keep every option in the portable fallback, including on non-interactive channels.
    const deliverable = question ? formatAssistantQuestion(question) : sanitizeDeliveryText(text)
    if (!deliverable) return { status: 'skipped', channelType, reason: 'empty_text' }

    // Web is not a delivery target — drop it (see the file header). The web UI
    // is a pull surface; persisting here would re-introduce the scheduled-job
    // clutter in the user's main chat thread. Doc-maintaining jobs omit
    // `deliver` so they never reach this path; legacy 'web' jobs surface a
    // typed `web_not_a_target` skip so the run-detail page shows the no-op
    // (and the authoring guard steers new workflows away from `web`).
    if (channelType === 'web') return { status: 'skipped', channelType, reason: 'web_not_a_target' }

    // Resolve placeholder routing before the authority check: authorization
    // is always against the exact conversation that will receive the text.
    let targetChannelId = channelId
    if (channelType === 'whatsapp' && !replyToTrigger && targetChannelId === 'notifications') {
      const waSession = await query<{ channel_id: string }>(
        `SELECT channel_id FROM sessions
         WHERE assistant_id = $1 AND user_id = $2 AND channel_type = 'whatsapp'
            AND channel_id LIKE '%@%'
         ORDER BY last_active_at DESC LIMIT 1`,
        [assistantId, userId],
      )
      if (!waSession.rows[0]) return { status: 'skipped', channelType, reason: 'no_recipient' }
      targetChannelId = waSession.rows[0].channel_id
    }

    let publicationApprovalId: string | undefined
    const authorizeAudience = (input: DeliveryAudienceInput) => (options.authorizeDeliveryAudience
      ?? createDeliveryAudienceAuthorizer({ integrationStore: options.integrationStore }))(input)
    const audienceInput: DeliveryAudienceInput = { workspaceId, assistantId, userId, channelType,
      channelId:targetChannelId,channelIntegrationId,recipientType:replyToTrigger?.recipientType,scopeEvidence }
    const refused = { status:'skipped',channelType,reason:'delivery_audience_unverified' } as const
    let admittedEvidence = scopeEvidence
    let addressed: { sessionId:string; version:string } | undefined
    const append = async () => {
      const session = await deliverySession(audienceInput)
      const stored = await persistDeliveryMessage(audienceInput,session,deliverable,admittedEvidence)
      if (!stored) return false
      onPersisted(stored.message.id)
      if (stored.version!==null) addressed = { sessionId:session.id,version:stored.version }
      return true
    }
    const dispatchAllowed = async () => {
      if (!addressed) return true // predecessor or separately consented external publication
      const current = await authorizeAudience(audienceInput)
      if (!current.allowed) return false
      return (await readDeliveryEnvelope(audienceInput,addressed.sessionId))?.version===addressed.version
    }
    const authorizePublication: AuthorizeWorkflowPublication = options.authorizeWorkflowPublication
      ?? (input => createWorkflowPublicationAuthorizer({ integrationStore: options.integrationStore })(input))
    const publicationInput = publication && !question && !questionResponse && !replyToTrigger
      && channelType === 'telegram' && channelIntegrationId && scopeEvidence !== undefined
      ? { workspaceId, assistantId, userId, channelType, channelId: targetChannelId,
          channelIntegrationId, scopeEvidence, publication } : null
    if (publication && scopeEvidence === undefined) {
      return { status: 'skipped', channelType, reason: 'delivery_audience_unverified' }
    }

    // Every unattended producer supplies a trusted snapshot, including the
    // explicit empty/public snapshot. Undefined remains a compatibility path
    // for interactive callers that R3d will bind to their live turn.
    if (scopeEvidence !== undefined) {
      const audience = await authorizeAudience(audienceInput)
      if (!audience.allowed) {
        const consent = publicationInput ? await authorizePublication(publicationInput) : null
        if (consent?.allowed) publicationApprovalId = consent.approvalId
        else return {
          status: 'skipped', channelType, reason: 'delivery_audience_unverified',
          ...(audience.detail ? { detail: audience.detail } : {}),
        }
      } else admittedEvidence = audience.evidence ?? scopeEvidence
    }

    // Bind every integrated delivery through the same durable capability store.
    // Integration-less transports cannot safely accept actionable questions.
    const store = options.questionStore ?? createChannelQuestionStore()
    const prepareQuestion = async (integrationId: string) => {
      const token = question ? await store.create({
        integrationId, workspaceId, assistantId, userId, channelId: targetChannelId,
        question, response: questionResponse,
        threadRef: channelType === 'slack' || channelType === 'feishu' ? threadRef : undefined,
      }) : undefined
      return {
        token,
        text: deliverable + (token && question ? workflowQuestionReplyHint(token, question, !!questionResponse) : ''),
        actions: actions ?? (token && question && questionResponse ? workflowQuestionActions(token, question) : undefined),
      }
    }
    const attachQuestion = async (token: string | undefined, messageId: string | void) => {
      if (token && messageId) await store.attach(token, messageId)
      if (token && !messageId) throw new Error('Question delivery returned no message ID; replies cannot be bound safely')
    }

    if (replyToTrigger) {
      if (channelType !== 'whatsapp' || !channelIntegrationId) {
        return { status: 'skipped', channelType, reason: 'provider_mismatch' }
      }
      const occurredAt = Date.parse(replyToTrigger.occurredAt)
      const now = options.now?.() ?? Date.now()
      if (!Number.isFinite(occurredAt) || now - occurredAt >= 24 * 60 * 60 * 1000) {
        return { status: 'skipped', channelType, reason: 'customer_service_window_expired' }
      }
      if (!options.integrationStore) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      const integration = await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
        workspaceId,
        assistantId,
        channelIntegrationId,
        'whatsapp',
        channelId,
      )
      if (!integration) return { status: 'skipped', channelType, reason: 'no_integration' }
      const credentials = integration.credentials as {
        provider?: unknown
        access_token?: unknown
        phone_number_id?: unknown
        graph_api_version?: unknown
      }
      if (
        credentials.provider !== 'cloud_api'
        || typeof credentials.access_token !== 'string'
        || typeof credentials.phone_number_id !== 'string'
        || credentials.phone_number_id !== replyToTrigger.providerAccountId
      ) {
        return { status: 'skipped', channelType, reason: 'provider_mismatch' }
      }
      if (!whatsappCloudUserAllowed(
        integration.config ?? {},
        replyToTrigger.actorId,
        replyToTrigger.recipientType === 'group',
      )) {
        return { status: 'skipped', channelType, reason: 'access_denied' }
      }

      if (!await append()) return refused
      const prepared = await prepareQuestion(integration.id)
      if (!await dispatchAllowed()) return refused
      const messageId = await createWhatsAppCloudAdapter({
        accessToken: credentials.access_token,
        phoneNumberId: credentials.phone_number_id,
        graphApiVersion: typeof credentials.graph_api_version === 'string'
          ? credentials.graph_api_version
          : undefined,
        recipientType: replyToTrigger.recipientType,
      }).sendMessage(targetChannelId, { text: prepared.text, format: 'markdown', actions: prepared.actions })
      await attachQuestion(prepared.token, messageId)
      return {
        status: 'delivered',
        channelType,
        channelId: targetChannelId,
        messageId: messageId || undefined,
      }
    }

    // Ordinary delivery remains DB-first. Publication consent authorizes the
    // provider sink, not a new independently readable transcript. Mixed private
    // sources cannot certify one derived session row; do not drop their lineage
    // to manufacture a copy. The workflow retains the result and original
    // evidence, plus an approval receipt on successful publication.
    if (!publicationApprovalId && !await append()) return refused

    if (channelType === 'telegram') {
      const tokens: Array<{ token: string; integrationId?: string; generation?: number }> = []
      if (options.integrationStore) {
        const integ = channelIntegrationId
          ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
              workspaceId,
              assistantId,
              channelIntegrationId,
              'telegram',
              channelId,
            )
          : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'telegram')
        const byoToken = integ && (integ.credentials as { bot_token?: string }).bot_token
        if (byoToken) tokens.push({ token: byoToken, integrationId: integ.id, generation: integ.identityGeneration })
      }
      if (!channelIntegrationId && options.defaultTelegramBotToken && (tokens.length === 0 || !question)) {
        tokens.push({ token: options.defaultTelegramBotToken })
      }
      if (tokens.length === 0) return { status: 'skipped', channelType, reason: 'no_integration' }
      // `threadRef` (an earlier delivery's message id) posts this one as a
      // reply; the returned message id lets a later `deliver.thread` step
      // reply under THIS message. See workflow.md → deliver `thread`.
      for (const [index, { token, integrationId, generation }] of tokens.entries()) {
        try {
          if (question && !integrationId) return { status: 'skipped', channelType, reason: 'no_integration' }
          const store = options.questionStore ?? createChannelQuestionStore()
          const questionToken = question && integrationId ? await store.create({
            integrationId, workspaceId, assistantId, userId, channelId, question, response: questionResponse, threadRef,
          }) : undefined
          const send = () => createTelegramAdapter({ token, strictTopic: !!questionToken || !!publicationApprovalId,
            ...(integrationId && generation != null ? { deliveryOrigin: { integrationId, generation } } : {}) }).sendMessage(
            channelId,
            { text: deliverable + (questionToken && question ? workflowQuestionReplyHint(questionToken, question, !!questionResponse) : ''), format: 'markdown',
              actions: actions ?? (questionToken && question && questionResponse ? workflowQuestionActions(questionToken, question) : undefined) },
            threadRef ? { threadTs: threadRef } : undefined,
          )
          let tgMessageId: string | void
          if (publicationApprovalId && publicationInput) {
            // Serialize dispatch with approval/revocation, then revalidate all
            // authority immediately before the provider call inside that boundary.
            const dispatch = options.dispatchWorkflowPublication ?? createWorkflowPublicationDispatcher({ integrationStore: options.integrationStore })
            const result = await dispatch(publicationInput, publicationApprovalId, send)
            if (!result.allowed) return { status: 'skipped', channelType, reason: 'delivery_audience_unverified' }
            tgMessageId = result.messageId
          } else {
            if (!await dispatchAllowed()) return refused
            tgMessageId = await send()
          }
          await attachQuestion(questionToken, tgMessageId)
          return { status: 'delivered', channelType, channelId, messageId: tgMessageId || undefined,
            ...(publicationApprovalId ? { publicationApprovalId } : {}) }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const canTryNext = index < tokens.length - 1
            && /Telegram API sendMessage:.*chat not found/i.test(message)
          if (!canTryNext) throw err
        }
      }
      throw new Error('Telegram delivery exhausted all configured bots')
    }

    if (channelType === 'slack') {
      if (!options.integrationStore) return { status: 'skipped', channelType, reason: 'no_integration' }
      const integ = channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(workspaceId, assistantId, channelIntegrationId, 'slack', channelId)
        : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'slack')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      // `threadRef` (an earlier delivery's Slack ts) posts into that thread;
      // the returned ts anchors later `deliver.thread` steps.
      const messageIds: string[] = []
      let attemptedMessages = 0, acknowledgedCalls = 0, failedCalls = 0
      let missingAcknowledgement = false, sendStarted = false, sendCompleted = false
      const receipt = (effect: SlackDeliveryReceipt['effect']): SlackDeliveryReceipt => ({
        channelId, attemptedMessages, messageIds: [...messageIds], effect,
        retrySafe: effect === 'none',
      })
      try {
        const prepared = await prepareQuestion(integ.id)
        const adapter = createSlackAdapter({
          botToken: (integ.credentials as { bot_token: string }).bot_token,
          botUserId: integ.botUserId ?? undefined,
          beforePostMessage: addressed ? async () => {
            if (!await dispatchAllowed()) throw new DeliveryAudienceWithdrawn()
          } : undefined,
          onOutboundAudit: async event => {
            if (event.kind !== 'post_message' || event.channel !== channelId) return
            attemptedMessages++
            if (event.status === 'failed') { failedCalls++; return }
            acknowledgedCalls++
            if (typeof event.externalTs === 'string' && event.externalTs.trim()) {
              if (!messageIds.includes(event.externalTs)) messageIds.push(event.externalTs)
            } else missingAcknowledgement = true
            // Deliberately do not retain event.text, event.error or credentials.
          },
        })
        if (!await dispatchAllowed()) return refused
        sendStarted = true
        const slackTs = await adapter.sendMessage(
          channelId,
          { text: prepared.text, format: 'markdown', actions: prepared.actions },
          threadRef ? { threadTs: threadRef } : undefined,
        )
        if (!slackTs || missingAcknowledgement) throw new Error('slack_acknowledgement_unavailable')
        if (!messageIds.includes(slackTs)) messageIds.push(slackTs)
        attemptedMessages = Math.max(attemptedMessages, messageIds.length)
        sendCompleted = true
        await attachQuestion(prepared.token, slackTs)
        return { status: 'delivered', channelType, channelId, messageId: slackTs, receipt: receipt('complete') }
      } catch (err) {
        const withdrawn = err instanceof DeliveryAudienceWithdrawn
        if (withdrawn && attemptedMessages===0) return refused
        const rejected = isSlackApiError(err) && err.method === 'chat.postMessage'
          && err.httpStatus === undefined && SLACK_NO_EFFECT_REJECTIONS.has(err.code)
          && failedCalls === 1 && !missingAcknowledgement
        const effect = sendCompleted ? 'complete'
          : !sendStarted || rejected && acknowledgedCalls === 0 && attemptedMessages === 1 ? 'none'
            : (rejected || withdrawn && !missingAcknowledgement) && acknowledgedCalls > 0 ? 'partial' : 'unknown'
        const saved = receipt(effect)
        return { status: 'failed', channelType, receipt: saved, error: slackDeliveryFailure(err, saved, threadRef) }
      }
    }

    if (channelType === 'feishu') {
      if (!options.integrationStore) return { status: 'skipped', channelType, reason: 'no_integration' }
      const integ = channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
            workspaceId,
            assistantId,
            channelIntegrationId,
            'feishu',
            channelId,
          )
        : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'feishu')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      const credentials = integ.credentials as FeishuCredentials
      const adapter = createFeishuAdapter({
        api: createFeishuApi({
          appId: credentials.app_id,
          appSecret: credentials.app_secret,
          brand: credentials.brand,
        }),
        botOpenId: integ.botUserId ?? undefined,
        config: { replyInThread: integ.config?.replyInThread ?? true },
      })
      const prepared = await prepareQuestion(integ.id)
      if (!await dispatchAllowed()) return refused
      const messageId = await adapter.sendMessage(
        channelId,
        { text: prepared.text, format: 'markdown', actions: prepared.actions },
        threadRef ? { threadTs: threadRef } : undefined,
      )
      await attachQuestion(prepared.token, messageId)
      return { status: 'delivered', channelType, channelId, messageId: messageId || undefined }
    }

    if (channelType === 'msteams') {
      if (!options.integrationStore) return { status: 'skipped', channelType, reason: 'no_integration' }
      const integ = channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(workspaceId, assistantId, channelIntegrationId, 'msteams', channelId)
        : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'msteams')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      const creds = integ.credentials as { app_id: string; app_password: string; tenant_id: string }
      // Teams proactive delivery needs a serviceUrl — there is no inbound
      // Activity here. Use the last-seen one persisted on the integration config
      // (msteams.md → "Outbound / proactive"); absent it, we cannot reach the
      // conversation yet, so skip rather than fail.
      const serviceUrl = integ.config?.msteamsServiceUrl
      if (!serviceUrl) return { status: 'skipped', channelType, reason: 'no_recipient' }
      const prepared = await prepareQuestion(integ.id)
      if (!await dispatchAllowed()) return refused
      const msgId = await createMsTeamsAdapter({
        appId: creds.app_id,
        appPassword: creds.app_password,
        tenantId: creds.tenant_id,
        serviceUrl,
        botId: integ.botUserId ?? undefined,
      }).sendMessage(channelId, { text: prepared.text, format: 'markdown', actions: prepared.actions })
      await attachQuestion(prepared.token, msgId)
      return { status: 'delivered', channelType, channelId, messageId: msgId || undefined }
    }

    if (channelType === 'custom') {
      if (!options.integrationStore || !options.customChannelStore) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      // The workspace channel is the delivery "account"; `channelId` here is
      // the peer (conversation) id on the bridged platform. Resolve the
      // channel through the assistant's routing (exact integration when the
      // step pinned one), then enqueue for the bridge.
      const integ = channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
            workspaceId,
            assistantId,
            channelIntegrationId,
            'custom',
            channelId,
          )
        : await options.integrationStore.getCredentialsForAssistantSystem(assistantId, 'custom')
      if (!integ) return { status: 'skipped', channelType, reason: 'no_integration' }
      const workspaceChannelId = integ.channelId
      const enqueue = options.customChannelStore
      const prepared = await prepareQuestion(integ.id)
      if (!await dispatchAllowed()) return refused
      const outboxId = await createCustomAdapter({
        enqueue: (item) => enqueue.enqueue(workspaceChannelId, { type: item.type, peerId: item.peerId, payload: item.payload }),
      }).sendMessage(channelId, {
        text: prepared.text,
        format: 'markdown',
        actions: prepared.actions,
      })
      await attachQuestion(prepared.token, outboxId)
      return { status: 'delivered', channelType, channelId, messageId: outboxId || undefined }
    }

    if (channelType === 'whatsapp') {
      if (!options.waConnectorUrl || !options.waConnectorSecret) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      if (!targetChannelId.includes('@')) {
        return { status: 'skipped', channelType, reason: 'no_integration' }
      }
      const integ = options.integrationStore && channelIntegrationId
        ? await options.integrationStore.getCredentialsForAssistantIntegrationSystem(
            workspaceId, assistantId, channelIntegrationId, 'whatsapp', targetChannelId)
        : undefined
      // Explicit integration is pinned: never silently deliver through system.
      if ((question || channelIntegrationId) && (!integ || (integ.credentials as { provider?: string }).provider === 'cloud_api' || !integ.channelId)) return { status: 'skipped', channelType, reason: 'no_integration' }
      const prepared = integ ? await prepareQuestion(integ.id) : { text: deliverable, token: undefined, actions }
      if (!await dispatchAllowed()) return refused
      const messageId = await createWhatsAppAdapter({
        connectorUrl: options.waConnectorUrl,
        connectorSecret: options.waConnectorSecret,
        connectionId: integ?.channelId ?? 'system',
      }).sendMessage(targetChannelId, { text: prepared.text, format: 'plain', actions: prepared.actions })
      await attachQuestion(prepared.token, messageId)
      return { status: 'delivered', channelType, channelId: targetChannelId, messageId: messageId || undefined }
    }

    return { status: 'skipped', channelType, reason: 'no_integration' }
  }
}
