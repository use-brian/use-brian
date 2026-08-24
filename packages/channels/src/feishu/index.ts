export { createFeishuAdapter, FEISHU_MAX_MESSAGE_LENGTH, toFeishuEmojiType } from './adapter.js'
export type { FeishuAdapterConfig, FeishuAdapterOptions } from './adapter.js'
export { buildFeishuCard } from './card.js'
export { feishuResourceRef, parseFeishuResourceRef } from './resource-ref.js'
export type {
  FeishuApi,
  FeishuBrand,
  FeishuCardAction,
  FeishuMention,
  FeishuNormalizedMessage,
  FeishuResourceDescriptor,
  FeishuResourceType,
  FeishuSendInput,
  FeishuSendOptions,
} from './types.js'
