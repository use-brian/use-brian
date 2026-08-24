export type FeishuBrand = 'feishu' | 'lark'

export type FeishuResourceType = 'image' | 'file' | 'audio' | 'video' | 'sticker'

export type FeishuResourceDescriptor = {
  type: FeishuResourceType
  fileKey: string
  fileName?: string
  durationMs?: number
  coverImageKey?: string
}

export type FeishuMention = {
  key: string
  openId?: string
  userId?: string
  name?: string
  isBot?: boolean
}

/**
 * Provider-normalized message forwarded by apps/feishu-connector.
 * This deliberately mirrors only the stable @larksuite/channel fields Brian
 * consumes. The bridge never sets `raw`, so provider event bodies cannot leak
 * into the API archive through this contract.
 */
export type FeishuNormalizedMessage = {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  chatMode?: 'p2p' | 'group' | 'topic'
  senderId: string
  senderName?: string
  senderType?: string
  senderIsBot?: boolean
  content: string
  rawContentType: string
  resources: FeishuResourceDescriptor[]
  mentions: FeishuMention[]
  mentionAll: boolean
  mentionedBot: boolean
  rootId?: string
  threadId?: string
  replyToMessageId?: string
  createTime: number
}

export type FeishuCardAction = {
  messageId: string
  chatId: string
  operator: { openId: string; userId?: string; name?: string }
  action: {
    value: unknown
    tag: string
    name?: string
    option?: string
    formValue?: Record<string, unknown>
  }
}

export type FeishuSendInput =
  | { text: string }
  | { markdown: string }
  | { card: object }
  | { image: { source: string | Buffer } }
  | { file: { source: string | Buffer; fileName: string } }
  | { audio: { source: string | Buffer; duration?: number } }
  | { video: { source: string | Buffer; duration?: number; coverImageKey?: string } }

export type FeishuSendOptions = {
  replyTo?: string
  replyInThread?: boolean
  resolveMentionsInText?: boolean
}

/** Provider port injected into the channel adapter by packages/api. */
export type FeishuApi = {
  send(to: string, input: FeishuSendInput, opts?: FeishuSendOptions): Promise<{ messageId: string }>
  editMessage(messageId: string, text: string): Promise<void>
  updateCard(messageId: string, card: object): Promise<void>
  recallMessage(messageId: string): Promise<void>
  addReaction(messageId: string, emojiType: string): Promise<string>
  removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean>
  /** Resolve the provider chat for a reaction event, which omits chatId. */
  getMessageChatId(messageId: string): Promise<string | null>
  downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<{ data: Uint8Array; contentType?: string }>
}
