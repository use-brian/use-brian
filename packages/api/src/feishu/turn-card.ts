import type { FeishuApi, FeishuSendOptions } from '@use-brian/channels'

/** One turn owns one card, timer and queue. Finalization always drains progress. */
export class FeishuTurnCard {
  private timer?: ReturnType<typeof setTimeout>
  private queue: Promise<void> = Promise.resolve()
  private latest = ''
  private sent = ''
  private sequence = 0
  private terminal = false
  private progressFailed = false

  private constructor(
    private readonly api: NonNullable<FeishuApi['streamingCards']>,
    private readonly cardId: string,
    readonly messageId: string,
  ) {}

  static async open(api: FeishuApi, chatId: string, text: string, opts?: FeishuSendOptions): Promise<FeishuTurnCard | undefined> {
    if (!api.streamingCards) return undefined
    try {
      const result = await api.streamingCards.open(chatId, text, opts)
      const card = new FeishuTurnCard(api.streamingCards, result.cardId, result.messageId)
      card.sent = text
      return card
    } catch (error) {
      reportCardFailure('open', error)
      return undefined
    }
  }

  /** Never wait for provider I/O on the model's tool-event path. */
  status(text: string): void {
    if (this.terminal || this.progressFailed) return
    this.latest = text.slice(0, 4000)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.queue = this.queue.then(async () => {
        if (this.terminal || this.progressFailed || this.latest === this.sent) return
        const snapshot = this.latest
        try {
          await this.api.update(this.cardId, snapshot, ++this.sequence)
          this.sent = snapshot
        } catch (error) {
          this.progressFailed = true
          reportCardFailure('progress', error)
        }
      })
    }, 600)
    this.timer.unref?.()
  }

  /** A failure is propagated: the caller must deliver a complete fallback. */
  async finish(text: string): Promise<string> {
    this.terminal = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const completion = this.queue.then(async () => {
      // Only pipeline-approved text reaches this boundary, never raw deltas.
      if (!this.progressFailed) {
        try {
          await this.api.update(this.cardId, text, ++this.sequence)
        } catch (error) {
          this.progressFailed = true
          reportCardFailure('answer', error)
        }
      }
      try {
        await this.api.finish(this.cardId, text, ++this.sequence)
      } catch (error) {
        reportCardFailure('finish', error)
        throw error
      }
      return this.messageId
    })
    // Keep the queue usable for a terminal recovery notice after failure.
    this.queue = completion.then(() => {}, () => {})
    return completion
  }
}

function reportCardFailure(operation: string, error: unknown): void {
  // No raw SDK errors, request content, credentials, or model text in logs.
  const code = error && typeof error === 'object' && 'providerCode' in error
    ? String(error.providerCode).slice(0, 40) : 'unavailable'
  console.warn(`[feishu] streaming card ${operation} failed (code=${code})`)
}
