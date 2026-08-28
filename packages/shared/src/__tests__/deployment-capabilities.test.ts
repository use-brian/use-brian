import { describe, expect, it } from 'vitest'
import {
  deploymentCapabilitiesFor,
  resolveDeploymentCapabilities,
  resolveDeploymentProfile,
} from '../deployment-capabilities.js'

describe('[COMP:shared/deployment-capabilities] deployment capability matrix', () => {
  it('defaults unset and unknown values to hosted', () => {
    expect(resolveDeploymentProfile(undefined)).toBe('hosted')
    expect(resolveDeploymentProfile('')).toBe('hosted')
    expect(resolveDeploymentProfile('unexpected')).toBe('hosted')
  })

  it('normalizes explicit profile values', () => {
    expect(resolveDeploymentProfile(' OSS ')).toBe('oss')
    expect(resolveDeploymentProfile('OUTPOST')).toBe('outpost')
    expect(resolveDeploymentProfile('hosted')).toBe('hosted')
  })

  it('keeps hosted billing and plan policy together', () => {
    expect(deploymentCapabilitiesFor('hosted')).toMatchObject({
      teammateManagement: true,
      localOwnerSession: false,
      billing: true,
      creditEnforcement: true,
      planEntitlements: true,
      hostedPlanLimits: true,
      managedInfrastructure: true,
    })
  })

  it('keeps OSS single-owner and unmetered', () => {
    expect(deploymentCapabilitiesFor('oss')).toMatchObject({
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
    })
  })

  it('enables Outpost teammates without hosted billing or local-owner auth', () => {
    expect(resolveDeploymentCapabilities('outpost')).toMatchObject({
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
    })
  })
})
