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
    im: { v1: { message: { update(input: {
      path: { message_id: string }
      data: { msg_type: 'post'; content: string }
    }): Promise<{ code?: number; msg?: string; log_id?: string }> } } }
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

type UnknownRecord = Record<string, unknown>

export type FeishuApiErrorDetails = {
  name: 'FeishuApiError'
  message: string
  operation: string
  endpoint: string
  providerCode?: number | string
  httpStatus?: number
  logId?: string
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : undefined
}

function errorChain(error: unknown): UnknownRecord[] {
  const chain: UnknownRecord[] = []
  let current = asRecord(error)
  const seen = new Set<UnknownRecord>()
  while (current && chain.length < 4 && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = asRecord(current.cause)
  }
  return chain
}

function safeErrorMessage(value: unknown): string {
  const source = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'Feishu API request failed'
  return source
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(authorization|cookie|app[_-]?secret|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /([?&](?:access_token|tenant_access_token|app_secret)=)[^&#\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500)
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function detailsFromSdkError(
  error: unknown,
  operation: string,
  endpoint: string,
): FeishuApiErrorDetails {
  const chain = errorChain(error)
  let providerCode: number | string | undefined
  let classifiedCode: string | undefined
  let httpStatus: number | undefined
  let logId: string | undefined
  let providerMessage: string | undefined
  let fallbackMessage: string | undefined

  for (const item of chain) {
    const response = asRecord(item.response)
    const data = asRecord(response?.data) ?? asRecord(item.data)
    const nested = asRecord(data?.error)
    const headers = asRecord(response?.headers)

    providerCode ??= numberValue(data?.code)
      ?? stringValue(data?.code)
    classifiedCode ??= typeof item.code === 'string' && !/^E[A-Z]+$/.test(item.code)
      ? item.code
      : undefined
    httpStatus ??= numberValue(response?.status) ?? numberValue(item.status)
    logId ??= stringValue(data?.log_id)
      ?? stringValue(nested?.log_id)
      ?? stringValue(headers?.['x-tt-logid'])
      ?? stringValue(headers?.['x-tt-log-id'])
    providerMessage ??= stringValue(data?.msg)
      ?? stringValue(data?.message)
    fallbackMessage ??= stringValue(item.message)
  }

  providerCode ??= classifiedCode

  return {
    name: 'FeishuApiError',
    message: safeErrorMessage(providerMessage ?? fallbackMessage),
    operation,
    endpoint,
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(logId !== undefined ? { logId: safeErrorMessage(logId) } : {}),
  }
}

/**
 * Credential-free replacement for SDK/Axios errors. The original error is
 * deliberately not retained as `cause`: it can carry Authorization headers,
 * app tokens, and the complete request config.
 */
export class FeishuApiError extends Error {
  readonly operation: string
  readonly endpoint: string
  readonly providerCode?: number | string
  readonly httpStatus?: number
  readonly logId?: string

  constructor(error: unknown, operation: string, endpoint: string) {
    const details = detailsFromSdkError(error, operation, endpoint)
    super(details.message)
    this.name = details.name
    this.operation = details.operation
    this.endpoint = details.endpoint
    this.providerCode = details.providerCode
    this.httpStatus = details.httpStatus
    this.logId = details.logId
  }

  toJSON(): FeishuApiErrorDetails {
    return {
      name: 'FeishuApiError',
      message: this.message,
      operation: this.operation,
      endpoint: this.endpoint,
      ...(this.providerCode !== undefined ? { providerCode: this.providerCode } : {}),
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      ...(this.logId !== undefined ? { logId: this.logId } : {}),
    }
  }
}

async function callFeishuSdk<T>(
  operation: string,
  endpoint: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof FeishuApiError) throw error
    throw new FeishuApiError(error, operation, endpoint)
  }
}

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
      const endpoint = opts?.replyTo
        ? '/open-apis/im/v1/messages/:message_id/reply'
        : '/open-apis/im/v1/messages'
      return callFeishuSdk('send', endpoint, () => channel.send(to, input, opts))
    },
    editMessage(messageId, text) {
      return callFeishuSdk(
        'edit_message',
        '/open-apis/im/v1/messages/:message_id',
        () => channel.editMessage(messageId, text),
      )
    },
    editPost(messageId, markdown) {
      return callFeishuSdk('edit_post', '/open-apis/im/v1/messages/:message_id', async () => {
        const result = await channel.rawClient.im.v1.message.update({
          path: { message_id: messageId },
          data: {
            msg_type: 'post',
            content: JSON.stringify({
              zh_cn: { title: '', content: [[{ tag: 'md', text: markdown }]] },
            }),
          },
        })
        if (result.code != null && result.code !== 0) {
          throw new FeishuApiError({ response: { data: result } },
            'edit_post', '/open-apis/im/v1/messages/:message_id')
        }
      })
    },
    updateCard(messageId, card) {
      return callFeishuSdk(
        'update_card',
        '/open-apis/im/v1/messages/:message_id',
        () => channel.updateCard(messageId, card),
      )
    },
    recallMessage(messageId) {
      return callFeishuSdk(
        'recall_message',
        '/open-apis/im/v1/messages/:message_id',
        () => channel.recallMessage(messageId),
      )
    },
    addReaction(messageId, emojiType) {
      return callFeishuSdk(
        'add_reaction',
        '/open-apis/im/v1/messages/:message_id/reactions',
        () => channel.addReaction(messageId, emojiType),
      )
    },
    removeReactionByEmoji(messageId, emojiType) {
      return callFeishuSdk(
        'remove_reaction',
        '/open-apis/im/v1/messages/:message_id/reactions',
        () => channel.removeReactionByEmoji(messageId, emojiType),
      )
    },
    async getMessageChatId(messageId) {
      const result = await callFeishuSdk(
        'fetch_message',
        '/open-apis/im/v1/messages/:message_id',
        () => channel.fetchMessage(messageId),
      )
      return result?.chatId ?? null
    },
    async getUserProfile(userId) {
      const endpoint = '/open-apis/contact/v3/users/:user_id'
      const response = await callFeishuSdk(
        'fetch_user_profile',
        endpoint,
        () => channel.rawClient.request({
          url: `/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=open_id`,
          method: 'GET',
        }),
      ) as {
        code?: number
        msg?: string
        data?: { user?: { email?: string; enterprise_email?: string; name?: string } }
      }
      if (response.code != null && response.code !== 0) {
        throw new FeishuApiError({ response: { data: response } }, 'fetch_user_profile', endpoint)
      }
      const user = response.data?.user
      const email = stringValue(user?.email) ?? stringValue(user?.enterprise_email)
      return {
        email: email?.toLowerCase() ?? null,
        displayName: stringValue(user?.name) ?? null,
      }
    },
    async downloadResource(messageId, fileKey, type) {
      const result = await callFeishuSdk(
        'download_resource',
        '/open-apis/im/v1/messages/:message_id/resources/:file_key',
        () => channel.downloadResourceWithMeta(messageId, fileKey, type),
      )
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
  const response = await callFeishuSdk(
    'validate_credentials',
    '/open-apis/bot/v3/info',
    () => channel.rawClient.request({
      url: '/open-apis/bot/v3/info',
      method: 'GET',
    }),
  ) as { code?: number; msg?: string; bot?: { open_id?: string; app_name?: string } }

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
