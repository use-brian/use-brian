import { describe, expect, it } from "vitest";
import { resolveRedeemWorkspace } from "../resolve-workspace";

const WS = [{ id: "ws-a" }, { id: "ws-b" }, { id: "ws-c" }];

describe("[COMP:app-web/redeem] Redeem target workspace resolution", () => {
  it("honors a valid `?ws=` override (the billing link's exact target)", () => {
    expect(resolveRedeemWorkspace(WS, "ws-b")).toBe("ws-b");
  });

  it("ignores an override that isn't one of the member's workspaces", () => {
    // A stale/forged ws id must not redeem against a workspace the member
    // doesn't belong to — fall back to their first workspace instead.
    expect(resolveRedeemWorkspace(WS, "ws-stranger")).toBe("ws-a");
  });

  it("falls back to the first workspace when no override is given", () => {
    expect(resolveRedeemWorkspace(WS, null)).toBe("ws-a");
    expect(resolveRedeemWorkspace(WS, undefined)).toBe("ws-a");
    expect(resolveRedeemWorkspace(WS, "")).toBe("ws-a");
  });

  it("returns null when the member has no workspaces", () => {
    expect(resolveRedeemWorkspace([], null)).toBeNull();
    expect(resolveRedeemWorkspace([], "ws-a")).toBeNull();
  });
});
