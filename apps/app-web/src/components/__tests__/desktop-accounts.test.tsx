// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { DesktopAccounts } from "../desktop-accounts";
import type { DesktopAccount } from "@/lib/desktop-auth-source";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: confirm }));
const rows: DesktopAccount[] = [
  { key: "cloud:one", id: "one", name: "Example User", email: "person@example.com", avatarUrl: "https://cdn.example/avatar.png", appUrl: "https://app.usebrian.ai", deployment: "cloud", active: false },
  { key: "local:one", id: "one", name: "Example User", email: "person@example.com", appUrl: "http://localhost:3003", deployment: "local", active: true },
  { key: "remote:one", id: "one", name: "Example User", email: "person@example.com", appUrl: "https://brain.example.com", deployment: "self-hosted", active: false },
];
let root: Root, host: HTMLDivElement;
const select = vi.fn(), selectCloud = vi.fn(), remove = vi.fn();
beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  select.mockReset().mockResolvedValue({ ok: false, error: "switch" });
  selectCloud.mockReset().mockResolvedValue({ ok: false });
  remove.mockReset().mockResolvedValue({ ok: true });
  window.usebrianDesktop = { signIn: vi.fn(), listAccounts: vi.fn().mockResolvedValue({ accounts: rows, canSwitch: true }), selectAccount: select, removeAccount: remove, selectCloud };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.usebrianDesktop; });
async function render() {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><DesktopAccounts /></I18nProvider>));
}

describe("[COMP:app-web/desktop-accounts] account provenance and switching", () => {
  it("distinguishes matching emails by chips and visible deployment addresses", async () => {
    await render();
    expect(host.textContent).toContain("Self-hosted");
    expect(host.querySelector<HTMLImageElement>('img[src="https://cdn.example/avatar.png"]')).not.toBeNull();
    const accountButtons = [...host.querySelectorAll("button")].filter((button) => button.getAttribute("aria-label")?.startsWith("person@example.com"));
    expect(accountButtons).toHaveLength(3);
    expect(accountButtons.map((button) => button.getAttribute("aria-current"))).toEqual([null, "true", null]);
    expect(accountButtons[1].textContent).toContain("http://localhost:3003");
    expect(accountButtons[2].querySelector("[title]")?.getAttribute("title")).toBe("Account from https://brain.example.com");
    await act(async () => accountButtons[0].click());
    expect(select).toHaveBeenCalledWith("cloud:one");
    expect(host.querySelector("[role=alert]")?.textContent).toBe(en.workspaceSwitcher.switchError);
    expect(accountButtons[1].getAttribute("aria-current")).toBe("true");
  });
  it("catches bridge rejection and offers retry without leaving a busy row", async () => {
    select.mockRejectedValue(new Error("IPC disconnected"));
    await render();
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false");
    expect(host.querySelector("[role=alert]")).not.toBeNull();
  });
  it("offers cloud recovery when there is no saved cloud session", async () => {
    window.usebrianDesktop!.listAccounts = vi.fn().mockResolvedValue({ accounts: rows.slice(1), canSwitch: true });
    await render();
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === en.workspaceSwitcher.openCloudAccount)!;
    await act(async () => button.click());
    expect(selectCloud).toHaveBeenCalledOnce();
  });
  it("confirm-removes only an inactive self-hosted connection", async () => {
    await render();
    const removeButton = host.querySelector<HTMLButtonElement>(`button[aria-label="Remove connection to https://brain.example.com"]`)!;
    expect(removeButton).not.toBeNull();
    expect(host.querySelector(`button[aria-label="Remove connection to http://localhost:3003"]`)).toBeNull();
    expect(host.querySelector(`button[aria-label="Remove connection to https://app.usebrian.ai"]`)).toBeNull();
    await act(async () => removeButton.click());
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: en.workspaceSwitcher.removeConnectionTitle,
      confirmLabel: en.workspaceSwitcher.removeConnectionConfirm,
      variant: "destructive",
    }));
    expect(remove).toHaveBeenCalledWith("remote:one");
    expect(host.textContent).not.toContain("https://brain.example.com");
  });
  it("keeps the row and reports a native removal failure", async () => {
    remove.mockResolvedValue({ ok: false, error: "remove" });
    await render();
    const removeButton = host.querySelector<HTMLButtonElement>(`button[aria-label="Remove connection to https://brain.example.com"]`)!;
    await act(async () => removeButton.click());
    expect(host.textContent).toContain("https://brain.example.com");
    expect(host.querySelector("[role=alert]")?.textContent).toBe(en.workspaceSwitcher.removeConnectionError);
    expect(host.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false");
  });
  it("hides removal when an older desktop bridge does not expose it", async () => {
    delete window.usebrianDesktop!.removeAccount;
    await render();
    expect(host.querySelector(`button[aria-label="Remove connection to https://brain.example.com"]`)).toBeNull();
  });
});
