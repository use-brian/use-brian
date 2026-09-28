import { describe, expect, it, vi } from "vitest";
import { deploymentKey, type AccountTarget } from "../deployment-accounts.js";
import { validateGatewayTarget } from "../gateway-target.js";

const initial: AccountTarget = { kind: "local", appUrl: "https://brain.example.com", apiUrl: "https://api.example.com", auth: "local-session" };

describe("destination gateway identity", () => {
  it.each([
    { ...initial, apiUrl: "https://other-api.example.com" },
    { ...initial, auth: "pkce" as const },
  ])("revalidates app and health in the resolved partition: %j", async (resolved) => {
    const contexts = vi.fn(deploymentKey);
    const discover = vi.fn(async () => ({ kind: "ready" as const, value: resolved }));
    const health = vi.fn(async () => ({ kind: "ready" as const, value: undefined }));
    expect(await validateGatewayTarget(initial, contexts, discover, health)).toEqual({ kind: "ready", value: resolved });
    expect(discover.mock.calls).toHaveLength(2);
    expect(contexts.mock.calls).toEqual([[initial], [resolved]]);
    expect(health).toHaveBeenCalledExactlyOnceWith(resolved, deploymentKey(resolved));
  });

  it.each(["cancelled", "unreachable", "authentication-required"] as const)("does not run health after final-jar discovery is %s", async (kind) => {
    const resolved = { ...initial, apiUrl: "https://other-api.example.com" };
    const health = vi.fn();
    const result = await validateGatewayTarget(initial, deploymentKey,
      async (target) => target === initial ? { kind: "ready", value: resolved } : { kind }, health);
    expect(result).toEqual({ kind });
    expect(health).not.toHaveBeenCalled();
  });

  it("bounds unstable discovery instead of accepting health from a different jar", async () => {
    const health = vi.fn();
    const discover = vi.fn(async (target: AccountTarget) => ({ kind: "ready" as const, value: {
      ...target, apiUrl: target.apiUrl === initial.apiUrl ? "https://other-api.example.com" : initial.apiUrl,
    } }));
    expect(await validateGatewayTarget(initial, deploymentKey, discover, health)).toEqual({ kind: "unreachable" });
    expect(discover).toHaveBeenCalledTimes(3);
    expect(health).not.toHaveBeenCalled();
  });
});
