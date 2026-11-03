// @vitest-environment jsdom
import React, { act, StrictMode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatModelTier } from "../chat-model";

const mocks = vi.hoisted(() => ({ hosted: false, authFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/edition", () => ({ deploymentCapabilities: () => ({ planEntitlements: mocks.hosted }) }));
vi.mock("@/lib/plan-gate", () => ({ modelTierPlanGateApplies: (caps: { planEntitlements: boolean }, plan: string, tier: string) =>
  caps.planEntitlements && plan === "free" && tier !== "standard" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
function Probe() {
  const state = useChatModelTier("fictional-workspace", "standard");
  return <button onClick={() => state.setModel("max")}>{state.model}</button>;
}
beforeEach(() => {
  window.localStorage.clear();
  mocks.hosted = false;
  mocks.authFetch.mockReset();
  container = document.createElement("div"); document.body.append(container);
});
afterEach(() => { act(() => root?.unmount()); root = undefined; container.remove(); vi.restoreAllMocks(); });

describe("[COMP:app-web/chat-model] saved-tier hydration", () => {
  it.each(["pro", "max"])("hydrates without rebuilding or overwriting saved %s", async tier => {
    window.localStorage.setItem("doc-chat-model", tier);
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const ui = <StrictMode><Probe /></StrictMode>;
    container.innerHTML = renderToString(ui);
    expect(container.textContent).toBe("standard");
    const original = container.firstChild;
    const onRecoverableError = vi.fn();
    await act(async () => { root = hydrateRoot(container, ui, { onRecoverableError }); });
    expect(container.firstChild).toBe(original);
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toBe(tier);
    expect(persist.mock.calls.filter(([key]) => key === "doc-chat-model").every(([,value]) => value === tier)).toBe(true);
    await act(async () => container.querySelector("button")!.click());
    expect(window.localStorage.getItem("doc-chat-model")).toBe("max");
  });

  it("keeps current plan clamping after restoring a saved choice", async () => {
    window.localStorage.setItem("doc-chat-model", "max");
    mocks.hosted = true;
    mocks.authFetch.mockResolvedValue({ ok: true, json: async () => ({ plan: "free" }) });
    container.innerHTML = renderToString(<Probe />);
    await act(async () => { root = hydrateRoot(container, <Probe />); });
    expect(container.textContent).toBe("standard");
    expect(window.localStorage.getItem("doc-chat-model")).toBe("standard");
  });

  it("retains the default when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage disabled"); });
    container.innerHTML = renderToString(<Probe />);
    const onRecoverableError = vi.fn();
    await act(async () => { root = hydrateRoot(container, <Probe />, { onRecoverableError }); });
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toBe("standard");
  });
});
