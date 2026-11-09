/** Pure provider/storage addressing. Never loads database stores or authority. */
const THREAD_SESSION_DELIMITER = ':thread:'
export const SLACK_THREAD_SESSION_DELIMITER = THREAD_SESSION_DELIMITER

export function buildThreadSessionChannelId(channelId: string, threadRoot?: string | null): string {
  return threadRoot ? `${channelId}${THREAD_SESSION_DELIMITER}${threadRoot}` : channelId
}
export function buildSlackSessionChannelId(channelId: string, threadTs?: string | null): string {
  return buildThreadSessionChannelId(channelId, threadTs)
}
/** Only Slack/Feishu store a provider channel with a separate native thread root. */
export function providerChannelIdFromSession(channelType: string, sessionChannelId: string): string {
  if (channelType !== 'slack' && channelType !== 'feishu') return sessionChannelId
  const delimiterIndex = sessionChannelId.indexOf(THREAD_SESSION_DELIMITER)
  return delimiterIndex === -1 ? sessionChannelId : sessionChannelId.slice(0, delimiterIndex)
}
