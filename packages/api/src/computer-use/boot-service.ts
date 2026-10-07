import { NativeComputerService } from './service.js'

/** API availability follows transport configuration, independently of the
 * relay/desktop opt-in flag. See INTEGRATION.md: API bootstrap. */
export function createNativeComputerService(config: {
  relayUrl?: string
  relaySecret?: string
  jwtSecret: string
  deploymentId?: string
}): NativeComputerService | null {
  const { relayUrl, relaySecret, jwtSecret, deploymentId } = config
  return relayUrl && relaySecret && deploymentId
    ? new NativeComputerService({ relayUrl, relaySecret, jwtSecret, deploymentId })
    : null
}
