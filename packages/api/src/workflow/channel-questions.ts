import { randomBytes } from 'node:crypto'
import type { AssistantQuestion, DeliverToChannel } from '@use-brian/core'
import { query } from '../db/client.js'

type ResponseBinding = NonNullable<Parameters<DeliverToChannel>[0]['questionResponse']>
export type ChannelQuestion = {
  token: string
  integrationId: string
  workspaceId: string
  assistantId: string
  userId: string
  channelId: string
  messageId: string | null
  /** Native thread root when the question was delivered within an existing thread. */
  threadRef?: string
  available?: boolean
  question: AssistantQuestion
  response?: ResponseBinding
}
export type QuestionAddress = Pick<ChannelQuestion, 'integrationId' | 'workspaceId' | 'assistantId' | 'userId' | 'channelId'>

/** Topic-qualified channelId is part of every lookup, never just the physical chat. */
export function createChannelQuestionStore(runQuery: typeof query = query) {
  return {
    async create(input: Omit<ChannelQuestion, 'token' | 'messageId'>) {
      const token = randomBytes(18).toString('base64url')
      await runQuery(`INSERT INTO workflow_channel_questions
        (token, integration_id, workspace_id, assistant_id, user_id, channel_id, question, response)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [token, input.integrationId, input.workspaceId, input.assistantId, input.userId,
        input.channelId, JSON.stringify({ ...input.question, ...(input.threadRef ? { __channelThreadRef: input.threadRef } : {}) }), input.response ? JSON.stringify(input.response) : null])
      return token
    },
    async attach(token: string, messageId: string) {
      await runQuery('UPDATE workflow_channel_questions SET message_id=$2 WHERE token=$1 AND message_id IS NULL', [token, messageId])
    },
    async find(address: QuestionAddress, selector: { token?: string; messageId?: string; answerMessageId?: string; threadId?: string }) {
      // Explicit replies also return expired/consumed tombstones so they NEVER
      // become unrestricted chat. Implicit typing stays within its native thread;
      // a reply under an originally top-level prompt uses that prompt as its root.
      // An exact source message wins over thread-root matching, even when it
      // is a tombstone. Thread-only matches exclude old questions, except for
      // replay of their own answer message. Do not LIMIT before this selection.
      const result = await runQuery<ChannelQuestion>(`WITH addressed AS (
        SELECT * FROM workflow_channel_questions
        WHERE integration_id=$1 AND channel_id=$2 AND workspace_id=$3 AND assistant_id=$4 AND user_id=$5
        AND message_id IS NOT NULL
      ) SELECT token,
        integration_id AS "integrationId", workspace_id AS "workspaceId",
        assistant_id AS "assistantId", user_id AS "userId", channel_id AS "channelId",
        message_id AS "messageId", question - '__channelThreadRef' AS question, response,
        question->>'__channelThreadRef' AS "threadRef",
        (consumed_at IS NULL AND expires_at > now()) AS available
        FROM addressed
        WHERE CASE WHEN $6::text IS NOT NULL THEN token=$6
                 WHEN $7::text IS NOT NULL THEN (message_id=$7 OR (
                   question->>'__channelThreadRef'=$7
                   AND (answer_message_id=$8 OR (consumed_at IS NULL AND expires_at > now()))
                   AND NOT EXISTS (SELECT 1 FROM addressed exact WHERE exact.message_id=$7)))
                 ELSE (answer_message_id=$8 OR (consumed_at IS NULL AND expires_at > now()))
                   AND (question->>'__channelThreadRef' IS NOT DISTINCT FROM $9::text
                     OR (question->>'__channelThreadRef' IS NULL AND message_id=$9)) END
        ORDER BY created_at DESC LIMIT 2`,
      [address.integrationId, address.channelId, address.workspaceId, address.assistantId, address.userId,
        selector.token ?? null, selector.messageId ?? null, selector.answerMessageId ?? null, selector.threadId ?? null])
      return result.rows
    },
    async isQuestionMessage(integrationId: string, channelId: string, messageId: string) {
      const result = await runQuery(`SELECT 1 FROM workflow_channel_questions
        WHERE integration_id=$1 AND channel_id=$2
        AND (message_id=$3 OR question->>'__channelThreadRef'=$3)`, [integrationId, channelId, messageId])
      return result.rows.length > 0
    },
    async consume(binding: ChannelQuestion, answerMessageId?: string) {
      const result = await runQuery(`UPDATE workflow_channel_questions SET consumed_at=now(), answer_message_id=$8
        WHERE token=$1 AND integration_id=$2 AND channel_id=$3 AND message_id=$4
        AND workspace_id=$5 AND assistant_id=$6 AND user_id=$7
        AND consumed_at IS NULL AND expires_at > now() RETURNING token`,
      [binding.token, binding.integrationId, binding.channelId, binding.messageId,
        binding.workspaceId, binding.assistantId, binding.userId, answerMessageId ?? null])
      return result.rows.length === 1
    },
  }
}
export type ChannelQuestionStore = ReturnType<typeof createChannelQuestionStore>
export const workflowQuestionActions = (token: string, question: AssistantQuestion) =>
  question.options?.map((label, index) => ({ id: String(index), label, data: `wq:${token}:${index}`, replyText: `wq:${token} ${index + 1}` }))

/** Portable explicit reply for transports without quote IDs or native buttons. */
export function parseWorkflowQuestionText(text: string): { token: string; answer: string } | null {
  const match = /^\s*wq:([\w-]{24})(?:\s+([\s\S]*))?\s*$/i.exec(text)
  return match ? { token: match[1]!, answer: match[2]?.trim() ?? '' } : null
}
export function workflowQuestionReplyHint(token: string, question: AssistantQuestion, actionable: boolean): string {
  const hint = !actionable ? '\nNo response action is configured. Replies will not run an action.'
    : (question.options?.length ? '\nReply with an option number or label.' : '\nReply with your answer.')
      + (question.allowCustom !== false && question.options?.length ? ' You may also type another answer.' : '')
      + `\nWithout a reply/quote, send: wq:${token} <answer>`
  return `${hint}\nQuestion reference: wq:${token}`
}

/** No webhook tool names or LLM inference: only the immutable authored binding. */
export async function handleChannelQuestionReply(params: {
  store: ChannelQuestionStore
  address: QuestionAddress
  callback?: { data: string; messageId: string }
  replyToMessageId?: string
  /** Current native thread root; absent means top-level, never any thread. */
  threadId?: string
  referenceToken?: string
  answerMessageId?: string
  text: string
  authorized: () => Promise<boolean>
  abortSignal?: AbortSignal
  /** Opt out when another surface (e.g. conversational ask) owns unbound text. */
  allowUnthreaded?: boolean
  dispatch: (binding: ChannelQuestion, answer: string, claim: () => Promise<boolean>) => Promise<string>
}): Promise<string | null> {
  const { store, address, callback } = params
  const typed = parseWorkflowQuestionText(params.text)
  if (/^\s*wq:/i.test(params.text) && !typed) return 'This question reference is invalid.'
  if (typed && params.referenceToken && typed.token !== params.referenceToken) return 'This question is unavailable.'
  const referenceToken = typed?.token ?? params.referenceToken
  const match = callback && /^wq:([\w-]{24}):([0-7])$/.exec(callback.data)
  if (callback && !match) return 'This question is unavailable.'
  if (!callback && !referenceToken && !params.replyToMessageId && !params.threadId && params.allowUnthreaded === false) return null
  const rows = await store.find(address, { token: match?.[1] ?? referenceToken, messageId: params.replyToMessageId, answerMessageId: params.answerMessageId, threadId: params.threadId })
  if (rows.length !== 1) {
    const questionMessageId = params.replyToMessageId ?? params.threadId
    if (callback || referenceToken || rows.length > 1 || (questionMessageId
      && await store.isQuestionMessage(address.integrationId, address.channelId, questionMessageId))) {
      return 'This question is unavailable or ambiguous. Reply to the original question from the authorized account.'
    }
    return null
  }
  const binding = rows[0]!
  // Defense in depth for injected stores: only explicit tokens/source replies
  // may recover a binding outside the current thread. Never consume implicit
  // text merely because this is the only active question in the physical chat.
  if (!callback && !referenceToken && !params.replyToMessageId
    && (binding.threadRef ?? undefined) !== params.threadId
    && !(binding.threadRef == null && params.threadId === binding.messageId)) return null
  if ((referenceToken && params.replyToMessageId && binding.messageId !== params.replyToMessageId && binding.threadRef !== params.replyToMessageId)
    || (callback && binding.messageId !== callback.messageId)) return 'This question is unavailable.'
  if (params.abortSignal?.aborted) return 'Stopped. No response action was run.'
  if (!await params.authorized()) return 'You are not authorized to answer this question.'
  if (params.abortSignal?.aborted) return 'Stopped. No response action was run.'
  const text = typed?.answer ?? params.text.trim()
  const options = binding.question.options ?? []
  const index = /^[1-9]\d*$/.test(text) ? Number(text) - 1 : -1
  const labels = options.filter(label => label.trim().toLocaleLowerCase() === text.toLocaleLowerCase())
  const answer = match ? options[Number(match[2])]
    : index >= 0 && index < options.length ? options[index]
      : labels.length === 1 ? labels[0] : text
  if (!answer || answer.length > 8000) return 'Please provide a valid answer.'
  if (binding.question.allowCustom === false && !binding.question.options?.includes(answer)) {
    return 'Please choose one of the listed options.'
  }
  if (binding.available === false) return 'This question has expired or was already answered.'
  if (!binding.response) return 'This workflow question has no response action configured. No action was run; ask the workflow author to configure it.'
  try { return await params.dispatch(binding, answer, () => store.consume(binding, params.answerMessageId)) }
  catch { return 'The answer could not be processed. No automatic retry will run; check the action status before requesting a new question.' }
}
