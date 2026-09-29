import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from '@use-brian/channels'

export type QuestionBinding = {
  integrationId: string
  assistantId: string
  userId: string
  sessionId?: string
  incoming: IncomingMessage
}

type PendingQuestion = QuestionBinding & { options: string[]; expires: number }
export type QuestionAnswer = PendingQuestion & { answer: string }
export type ConversationalQuestion = { question: string; options?: string[] }

/** Process-local conversational UI, not durable workflow response authorization.
 * Call resolve only after authenticating/routing the current sender, under the
 * channel's conversation lock. Missing state leaves ordinary text untouched.
 */
export class ChannelQuestions {
  private readonly pending = new Map<string, PendingQuestion>()
  constructor(private readonly now = Date.now) {}

  invalidate(integrationId: string, incoming: IncomingMessage): void {
    for (const [token, item] of this.pending) {
      if (item.expires <= this.now() || this.matches(item, integrationId, incoming.channelId, incoming.userId)) {
        this.pending.delete(token)
      }
    }
  }

  private matches(item: PendingQuestion, integrationId: string, channelId: string, senderId: string) {
    return item.integrationId === integrationId && item.incoming.channelId === channelId
      && item.incoming.userId === senderId
  }

  has(binding: QuestionBinding): boolean {
    return [...this.pending.values()].some(item => item.expires > this.now()
      && this.matches(item, binding.integrationId, binding.incoming.channelId, binding.incoming.userId)
      && item.assistantId === binding.assistantId && item.userId === binding.userId
      && (item.sessionId ?? item.incoming.channelId) === (binding.sessionId ?? binding.incoming.channelId))
  }

  create(binding: QuestionBinding, options: string[]) {
    for (const [token, item] of this.pending) {
      if (item.expires <= this.now() || (this.matches(item, binding.integrationId, binding.incoming.channelId, binding.incoming.userId)
        && (item.sessionId ?? item.incoming.channelId) === (binding.sessionId ?? binding.incoming.channelId))) this.pending.delete(token)
    }
    if (!options.length) return []
    while (this.pending.size >= 1000) this.pending.delete(this.pending.keys().next().value!)
    const token = randomBytes(12).toString('base64url')
    this.pending.set(token, {
      ...binding, incoming: { ...binding.incoming }, options: [...options], expires: this.now() + 24 * 60 * 60 * 1000,
    })
    return options.map((label, index) => ({ id: String(index), label, data: `ask:${token}:${index}`, replyText: label }))
  }

  /** Legacy callback API. Prefer resolve, which also checks resolved identities. */
  take(data: string, integrationId: string, channelId: string, senderId: string): QuestionAnswer | null {
    return this.takeAction(data, integrationId, channelId, senderId)
  }

  private takeAction(data: string, integrationId: string, channelId: string, senderId: string,
    identity?: Pick<QuestionBinding, 'assistantId' | 'userId'>): QuestionAnswer | null {
    const match = /^ask:([\w-]{16}):(0|[1-9]\d*)$/.exec(data)
    if (!match) return null
    const item = this.pending.get(match[1]!)
    if (!item) return null
    if (item.expires <= this.now()) {
      this.pending.delete(match[1]!)
      return null
    }
    if (!this.matches(item, integrationId, channelId, senderId)
      || (identity && (item.assistantId !== identity.assistantId || item.userId !== identity.userId))) return null
    const answer = item.options[Number(match[2])]
    if (answer === undefined) return null
    this.pending.delete(match[1]!)
    return { ...item, answer }
  }

  /** Numbers are one-based, as rendered by core's formatAssistantQuestion.
   * Labels are matched case-insensitively; the original option is returned.
   * Non-option prose is a custom answer. Invalid numeric choices and blank
   * text do not consume; opaque ask tokens never become custom answers.
   * optionsOnly recognizes authored labels/numbers without consuming arbitrary
   * prose, so pipeline admission can distinguish choices from workflow replies.
   */
  resolve(binding: QuestionBinding, actionData?: string, optionsOnly = false): QuestionAnswer | null {
    const { integrationId, incoming } = binding
    const text = incoming.text.trim()
    if (!optionsOnly && (actionData !== undefined || text.startsWith('ask:'))) {
      return this.takeAction(actionData ?? text, integrationId, incoming.channelId, incoming.userId, binding)
    }
    if (!text) return null
    for (const [token, item] of this.pending) {
      if (item.expires <= this.now()) {
        this.pending.delete(token)
        continue
      }
      if (!this.matches(item, integrationId, incoming.channelId, incoming.userId)
        || item.assistantId !== binding.assistantId || item.userId !== binding.userId
        || (item.sessionId ?? item.incoming.channelId) !== (binding.sessionId ?? incoming.channelId)) continue
      const label = item.options.find(option => option.trim().toLowerCase() === text.toLowerCase())
      if (optionsOnly && !label && !/^\d+$/.test(text)) return null
      const answer = label ?? (/^\d+$/.test(text) ? item.options[Number(text) - 1] : text)
      if (answer === undefined) return null
      this.pending.delete(token)
      return { ...item, answer }
    }
    return null
  }
}

/** All providers (including BYON and email) must use the same instance. */
export const channelQuestions = new ChannelQuestions()

/** Call from sendResponse with the pipeline's terminal question. Text is
 * already formatted by deliverChannelResponse; do not append choices again.
 * Text-only transports still need this registration for numeric replies.
 */
export function channelQuestionActions(binding: QuestionBinding, question?: ConversationalQuestion,
  questions = channelQuestions) {
  if (!question) return undefined
  return questions.create(binding, question.options ?? [])
}

export type ChannelQuestionResolution =
  | { kind: 'answer'; incoming: IncomingMessage; binding: QuestionAnswer }
  | { kind: 'unavailable'; incoming: IncomingMessage }
  | { kind: 'message'; incoming: IncomingMessage }

/** Native callbacks supply actionData explicitly. Drop unavailable callbacks
 * (optionally acknowledge expiry); never send opaque tokens to the engine.
 * The rewritten message keeps the CURRENT sender/event metadata, not the
 * original question's message ID, attachments, timestamp or raw payload.
 */
export function resolveChannelQuestion(binding: QuestionBinding, actionData?: string,
  questions = channelQuestions): ChannelQuestionResolution {
  const answer = questions.resolve(binding, actionData)
  if (answer) return { kind: 'answer', incoming: { ...binding.incoming, text: answer.answer }, binding: answer }
  return { kind: actionData !== undefined || binding.incoming.text.trim().startsWith('ask:') ? 'unavailable' : 'message',
    incoming: binding.incoming }
}
