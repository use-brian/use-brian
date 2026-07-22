export { createWechatAdapter, type WechatAdapterOptions } from './adapter.js'
export { markdownToWechat } from './markdown.js'
export {
  createIlinkClient,
  fetchBotQrcode,
  pollQrcodeStatus,
  ILINK_DEFAULT_BASE_URL,
  ILINK_CDN_BASE_URL,
  ILINK_STALE_TOKEN_ERRCODE,
  WeixinMessageType,
  WeixinItemType,
  WeixinMessageState,
  type IlinkClient,
  type IlinkQrStatus,
  type IlinkQrStatusResponse,
  type IlinkGetUpdatesResponse,
  type WeixinMessage,
  type WeixinMessageItem,
  type IlinkCdnMedia,
} from './ilink.js'
export {
  decryptAesEcb,
  parseIlinkAesKey,
  sniffImageMime,
  findWechatMediaItem,
  downloadWechatMediaItem,
  type WechatDownloadedMedia,
} from './media.js'
