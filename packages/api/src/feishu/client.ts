/**
 * Official-SDK-backed Feishu/Lark REST client.
 *
 * The inbound WebSocket lives in apps/feishu-connector. This client is created
 * in the API process for validation and outbound delivery only; creating it
 * never opens a second event connection.
 *
 * [COMP:channels/feishu]
 */

import { createLarkChannel } from '@larksuite/channel'
import type {
  FeishuApi,
  FeishuBrand,
  FeishuSendInput,
  FeishuSendOptions,
} from '@use-brian/channels'

export const FEISHU_API_DOMAINS: Readonly<Record<FeishuBrand, string>> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

export function feishuDomainForBrand(brand: FeishuBrand): string {
  return FEISHU_API_DOMAINS[brand]
}

export type FeishuAppCredentialsInput = {
  appId: string
  appSecret: string
  brand: FeishuBrand
}

type SdkChannel = {
  send(to: string, input: FeishuSendInput, opts?: FeishuSendOptions): Promise<{ messageId: string }>
  editMessage(messageId: string, text: string): Promise<void>
  updateCard(messageId: string, card: object): Promise<void>
  recallMessage(messageId: string): Promise<void>
  addReaction(messageId: string, emojiType: string): Promise<string>
  removeReactionByEmoji(messageId: string, emojiType: string): Promise<boolean>
  fetchMessage(messageId: string): Promise<{ chatId: string } | undefined>
  downloadResourceWithMeta(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<{ buffer: Buffer; contentType?: string }>
  rawClient: {
    request(input: { url: string; method: 'GET' }): Promise<unknown>
  }
}

export type FeishuChannelFactory = (options: {
  appId: string
  appSecret: string
  domain: string
  transport: 'webhook'
  httpTimeoutMs: number
  source: string
}) => SdkChannel

const defaultFactory: FeishuChannelFactory = (options) => createLarkChannel(options) as SdkChannel

function makeChannel(
  credentials: FeishuAppCredentialsInput,
  factory: FeishuChannelFactory,
): SdkChannel {
  return factory({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: feishuDomainForBrand(credentials.brand),
    // Outbound/validation only. The webhook transport avoids constructing a
    // WebSocket client while retaining the official sender and raw REST client.
    transport: 'webhook',
    httpTimeoutMs: 15_000,
    source: 'use-brian',
  })
}

export function createFeishuApi(
  credentials: FeishuAppCredentialsInput,
  factory: FeishuChannelFactory = defaultFactory,
): FeishuApi {
  const channel = makeChannel(credentials, factory)
  return {
    send(to, input, opts) {
      return channel.send(to, input, opts)
    },
    editMessage(messageId, text) {
      return channel.editMessage(messageId, text)
    },
    updateCard(messageId, card) {
      return channel.updateCard(messageId, card)
    },
    recallMessage(messageId) {
      return channel.recallMessage(messageId)
    },
    addReaction(messageId, emojiType) {
      return channel.addReaction(messageId, emojiType)
    },
    removeReactionByEmoji(messageId, emojiType) {
      return channel.removeReactionByEmoji(messageId, emojiType)
    },
    async getMessageChatId(messageId) {
      return (await channel.fetchMessage(messageId))?.chatId ?? null
    },
    async downloadResource(messageId, fileKey, type) {
      const result = await channel.downloadResourceWithMeta(messageId, fileKey, type)
      return { data: new Uint8Array(result.buffer), contentType: result.contentType }
    },
  }
}

export type FeishuCredentialInfo = {
  botOpenId: string
  botName: string
}

/** Validate app credentials without opening a WebSocket connection. */
export async function validateFeishuCredentials(
  credentials: FeishuAppCredentialsInput,
  factory: FeishuChannelFactory = defaultFactory,
): Promise<FeishuCredentialInfo> {
  const channel = makeChannel(credentials, factory)
  const response = await channel.rawClient.request({
    url: '/open-apis/bot/v3/info',
    method: 'GET',
  }) as { code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } }

  if (response.code != null && response.code !== 0) {
    throw new Error(`Feishu bot info failed (${response.code}): ${response.msg ?? 'unknown error'}`)
  }
  if (!response.bot?.open_id) {
    throw new Error('Feishu bot info response did not include bot.open_id')
  }
  return {
    botOpenId: response.bot.open_id,
    botName: response.bot.app_name?.trim() || 'Feishu bot',
  }
}
