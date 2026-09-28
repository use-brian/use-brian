import { deploymentKey, type AccountTarget } from "./deployment-accounts.js";

export type TargetProbe<T> =
  | { kind: "ready"; value: T }
  | { kind: "authentication-required" | "unreachable" | "cancelled" };

/** Discovery may change the partition identity (API URL or auth mode). Never
 * migrate cookies across identities: authenticate and verify the final jar.
 * Bound discovery churn so a changing/malicious config cannot loop forever.
 */
export async function validateGatewayTarget<C>(
  initial: AccountTarget,
  contextFor: (target: AccountTarget) => C,
  discover: (target: AccountTarget, context: C) => Promise<TargetProbe<AccountTarget>>,
  health: (target: AccountTarget, context: C) => Promise<TargetProbe<unknown>>,
): Promise<TargetProbe<AccountTarget>> {
  let target = initial;
  for (let attempt = 0; attempt < 3; attempt++) {
    const context = contextFor(target);
    const config = await discover(target, context);
    if (config.kind !== "ready") return config;
    if (deploymentKey(config.value) !== deploymentKey(target)) {
      target = config.value;
      continue;
    }
    const result = await health(config.value, context);
    if (result.kind !== "ready") return result;
    return { kind: "ready", value: config.value };
  }
  return { kind: "unreachable" };
}
