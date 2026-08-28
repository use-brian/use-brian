export const DEPLOYMENT_PROFILES = ['hosted', 'oss', 'outpost'] as const

export type DeploymentProfile = (typeof DEPLOYMENT_PROFILES)[number]

export type DeploymentCapabilities = Readonly<{
  teammateManagement: boolean
  localOwnerSession: boolean
  billing: boolean
  creditEnforcement: boolean
  planEntitlements: boolean
  hostedPlanLimits: boolean
  managedInfrastructure: boolean
  selfManagedProviders: boolean
  hostedUpgradePrompts: boolean
  researchPlanGate: boolean
}>

const CAPABILITIES: Record<DeploymentProfile, DeploymentCapabilities> = {
  hosted: {
    teammateManagement: true,
    localOwnerSession: false,
    billing: true,
    creditEnforcement: true,
    planEntitlements: true,
    hostedPlanLimits: true,
    managedInfrastructure: true,
    selfManagedProviders: false,
    hostedUpgradePrompts: false,
    researchPlanGate: true,
  },
  oss: {
    teammateManagement: false,
    localOwnerSession: true,
    billing: false,
    creditEnforcement: false,
    planEntitlements: false,
    hostedPlanLimits: false,
    managedInfrastructure: false,
    selfManagedProviders: true,
    hostedUpgradePrompts: true,
    researchPlanGate: true,
  },
  outpost: {
    teammateManagement: true,
    localOwnerSession: false,
    billing: false,
    creditEnforcement: false,
    planEntitlements: false,
    hostedPlanLimits: false,
    managedInfrastructure: false,
    selfManagedProviders: true,
    hostedUpgradePrompts: false,
    researchPlanGate: false,
  },
}

/** Unset and unknown values preserve the hosted-safe historical default. */
export function resolveDeploymentProfile(value: string | null | undefined): DeploymentProfile {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'oss' || normalized === 'outpost') return normalized
  return 'hosted'
}

export function deploymentCapabilitiesFor(
  profile: DeploymentProfile,
): DeploymentCapabilities {
  return CAPABILITIES[profile]
}

export function resolveDeploymentCapabilities(
  value: string | null | undefined,
): DeploymentCapabilities {
  return deploymentCapabilitiesFor(resolveDeploymentProfile(value))
}
