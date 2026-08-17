import type { ChannelIntegrationConfig } from '../db/channel-integrations.js'

export function whatsappCloudUserAllowed(
  config: ChannelIntegrationConfig,
  userId: string,
): boolean {
  // Public business numbers fail closed until an operator chooses an access
  // mode; this also protects the partial provisioning window.
  if (!config.userAccessMode) return false
  if (config.userAccessMode === 'allowlist') {
    return (config.allowedUserIds ?? []).includes(userId)
  }
  if (config.userAccessMode === 'blocklist') {
    return !(config.blockedUserIds ?? []).includes(userId)
  }
  return config.userAccessMode === 'allow_all'
}
