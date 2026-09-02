import {
  deploymentCapabilitiesFor,
  resolveDeploymentProfile,
  type DeploymentCapabilities,
  type DeploymentProfile,
} from "@use-brian/shared/deployment-capabilities";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";

export function usebrianEdition(): DeploymentProfile {
  return resolveDeploymentProfile(publicRuntimeConfig().edition);
}

export function deploymentCapabilities(): DeploymentCapabilities {
  return deploymentCapabilitiesFor(usebrianEdition());
}

/** True in the open single-player edition (no billing, no teammates). */
export function isOssEdition(): boolean {
  return usebrianEdition() === "oss";
}

/** True only in hosted SaaS, not in the multi-user Outpost profile. */
export function isHostedEdition(): boolean {
  return usebrianEdition() === "hosted";
}

/**
 * Where the open edition sends a user who wants teammates or other cloud
 * features. A canonical absolute URL (not `webAppUrl()`, which resolves to a
 * local dev origin in the OSS launcher) so the upgrade link always points at
 * the real hosted product.
 */
export const HOSTED_UPGRADE_URL = "https://usebrian.ai/plans";
