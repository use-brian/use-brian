import {
  deploymentCapabilitiesFor,
  resolveDeploymentProfile,
  type DeploymentCapabilities,
  type DeploymentProfile,
} from '@use-brian/shared/deployment-capabilities'

export function deploymentProfile(): DeploymentProfile {
  return resolveDeploymentProfile(
    process.env.USEBRIAN_EDITION
      ?? process.env.NEXT_PUBLIC_USEBRIAN_EDITION
      ?? process.env.SIDANCLAW_EDITION,
  )
}

export function deploymentCapabilities(): DeploymentCapabilities {
  return deploymentCapabilitiesFor(deploymentProfile())
}

/** Open control-plane routes owned by the standalone OSS and Outpost API. */
export function usesOpenStandaloneRoutes(profile: DeploymentProfile): boolean {
  return profile === 'oss' || profile === 'outpost'
}

/** Server-side open-edition predicate. Outpost is intentionally not OSS. */
export function isOssEdition(): boolean {
  return deploymentProfile() === 'oss'
}
