// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "http://localhost:4000" }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "ws-example" }) }));
vi.mock("@/lib/edition", () => ({ isOssEdition: () => false, isHostedEdition: () => true }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => false) }));

import { AccountSection } from "../account-section";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { getUserInfo, setUserInfoCache } from "@/lib/user";

const profile = { id: "viewer-example", name: "Sample Viewer", email: "viewer@example.com", avatarUrl: "https://cdn.example/avatar.png" };
let host: HTMLDivElement;
let root: Root;
const refreshTokens = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setUserInfoCache(null);
  refreshTokens.mockReset();
  // Released shell: tokens and active ID exist, but getCurrentUser does not.
  Object.assign(window, { usebrianDesktop: {
    getAccessToken: () => "token",
    getUserId: () => profile.id,
    refreshTokens,
  } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).usebrianDesktop;
  setUserInfoCache(null);
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><AccountSection /></I18nProvider>));
}
const nameInput = () => host.querySelector<HTMLInputElement>('input[type="text"]')!;
const emailInput = () => host.querySelector<HTMLInputElement>('input[type="email"]')!;

describe("[COMP:app-web/account-profile] Account identity hydration", () => {
  it("hydrates the name, email and photo from a legacy shell refresh without cookies", async () => {
    let finish!: (result: unknown) => void;
    refreshTokens.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount();
    expect(nameInput().value).toBe("");
    expect(emailInput().value).toBe("");
    await act(async () => finish({ kind: "ok", tokens: { accessToken: "fresh", refreshToken: "refresh", user: profile } }));
    expect(nameInput().value).toBe(profile.name);
    expect(emailInput().value).toBe(profile.email);
    expect(host.querySelector("img")?.getAttribute("src")).toBe(profile.avatarUrl);
    expect(getUserInfo()).toEqual(profile);
    expect(refreshTokens).toHaveBeenCalledOnce();
  });

  it("offers retry when refresh fails and recovers the profile on retry", async () => {
    refreshTokens.mockResolvedValueOnce({ kind: "transient" }).mockResolvedValueOnce({ kind: "ok", tokens: { accessToken: "fresh", user: profile } });
    await mount();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(en.settings.account.profileLoadError);
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === en.settings.account.retry)!;
    await act(async () => retry.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(nameInput().value).toBe(profile.name);
    expect(emailInput().value).toBe(profile.email);
  });

  it("updates a mounted profile without overwriting an unsaved name", async () => {
    setUserInfoCache(profile);
    await mount();
    expect(nameInput().value).toBe(profile.name);
    expect(refreshTokens).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput(), "My draft");
      nameInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => setUserInfoCache({ ...profile, name: "Refreshed Name", email: "updated@example.com", avatarUrl: "https://cdn.example/new.png" }));
    expect(nameInput().value).toBe("My draft");
    expect(emailInput().value).toBe("updated@example.com");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example/new.png");
  });

  it("does not expose a previous native account's cached identity", async () => {
    setUserInfoCache({ ...profile, id: "previous-account" });
    expect(getUserInfo()).toBeNull();
  });
});
