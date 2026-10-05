// @vitest-environment jsdom
import { act, cloneElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { DesktopAccounts } from "../desktop-accounts";
import type { DesktopAccount } from "@/lib/desktop-auth-source";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: confirm }));
vi.mock("@/components/ui/emoji-picker", () => ({
  EmojiPicker: ({ trigger, onPick }: { trigger: ReactElement<{ onClick?: () => void }>; onPick: (icon: string) => void }) =>
    cloneElement(trigger, { onClick: () => onPick("🏡") }),
}));
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
  it("customizes a saved identity and reorders without switching accounts", async () => {
    let current = rows.map((row) => ({ ...row }));
    const update = vi.fn(async (key: string, presentation: { displayName: string; icon: string }) => {
      current = current.map((row) => row.key === key ? { ...row, ...presentation } : row);
      return { ok: true as const, accounts: current };
    });
    const move = vi.fn(async () => ({ ok: true as const, accounts: [current[1], current[0], current[2]] }));
    window.usebrianDesktop!.updateAccountPresentation = update;
    window.usebrianDesktop!.moveAccount = move;
    await render();
    const clickText = async (text: string) => act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!.click());
    await clickText(en.workspaceSwitcher.customizeAccounts);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Move person@example.com up"]')!.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit person@example.com"]')!.click());
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Work cloud");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${en.workspaceSwitcher.accountIcon}"]`)!.click());
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(update).toHaveBeenCalledWith("cloud:one", { displayName: "Work cloud", icon: "🏡" });
    expect(host.textContent).toContain("Work cloud");
    expect(host.textContent).toContain("🏡");
    expect(host.textContent).toContain("https://app.usebrian.ai");
    expect(host.querySelector('img[src="https://cdn.example/avatar.png"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Move Work cloud down"]')!.click());
    expect(move).toHaveBeenCalledWith("cloud:one", "down");
    expect(host.querySelector<HTMLButtonElement>('button[role="menuitem"]')!.getAttribute("aria-label")).toContain("Local");
    expect(select).not.toHaveBeenCalled();
    await clickText(en.workspaceSwitcher.customizeDone);
    expect(host.querySelector('[aria-label="Edit Work cloud"]')).toBeNull();
  });
  it("previews an uploaded image, saves only on submit, and supports reset and cancel", async () => {
    const icon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=";
    const update = vi.fn(async (key, presentation) => ({ ok: true, accounts: rows.map(row => row.key === key ? { ...row, ...presentation } : row) }));
    window.usebrianDesktop!.updateAccountPresentation = update;
    window.usebrianDesktop!.moveAccount = vi.fn();
    const revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:test"); static revokeObjectURL = revoke; });
    const decode = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Image", class { src = ""; naturalWidth = 400; naturalHeight = 200; decode = decode; });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(icon);
    try {
      await render();
      const click = async (text: string) => act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === text)!.click());
      const edit = async () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit person@example.com"]')!.click());
      const upload = async (file: File) => {
        const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
      };
      await click(en.workspaceSwitcher.customizeAccounts);
      await edit();
      await upload(new File(["image"], "avatar.png", { type: "image/png" }));
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 100, 0, 200, 200, 0, 0, 128, 128);
      expect(revoke).toHaveBeenCalledWith("blob:test");
      expect(host.querySelector("form img")?.getAttribute("src")).toBe(icon);
      expect(update).not.toHaveBeenCalled();
      await upload(new File(["bad"], "icon.svg", { type: "image/svg+xml" }));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.workspaceSwitcher.accountImageError);
      expect(host.querySelector("form img")?.getAttribute("src")).toBe(icon);
      await upload(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }));
      expect(decode).toHaveBeenCalledTimes(1);
      decode.mockRejectedValueOnce(new Error("Cannot decode"));
      await upload(new File(["corrupt"], "broken.png", { type: "image/png" }));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.workspaceSwitcher.accountImageError);
      expect(host.querySelector("form img")?.getAttribute("src")).toBe(icon);
      expect(host.querySelector('[aria-busy]')?.getAttribute("aria-busy")).toBe("false");
      await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(update).toHaveBeenCalledWith("cloud:one", { displayName: "", icon });
      expect(host.querySelector(`img[src="${icon}"]`)).not.toBeNull();
      await edit();
      await click(en.workspaceSwitcher.resetAccountIcon);
      await click(en.workspaceSwitcher.addAccountDialog.cancel);
      expect(update).toHaveBeenCalledTimes(1);
      expect(host.querySelector(`img[src="${icon}"]`)).not.toBeNull();
      await edit();
      await click(en.workspaceSwitcher.resetAccountIcon);
      await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(host.querySelector('img[src="https://cdn.example/avatar.png"]')).not.toBeNull();
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
  it("keeps the name draft and existing rows on failed customization", async () => {
    window.usebrianDesktop!.updateAccountPresentation = vi.fn().mockResolvedValue({ ok: false });
    window.usebrianDesktop!.moveAccount = vi.fn().mockRejectedValue(new Error("IPC disconnected"));
    await render();
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === en.workspaceSwitcher.customizeAccounts)!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Edit person@example.com"]')!.click());
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.workspaceSwitcher.customizeError);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Move person@example.com down"]')!.click());
    expect(host.querySelector<HTMLButtonElement>('button[role="menuitem"]')!.getAttribute("aria-label")).toContain("Cloud");
    expect(host.querySelector('[aria-busy]')?.getAttribute("aria-busy")).toBe("false");
  });
  it("hides customization on older shells and gives Cloud its own badge color", async () => {
    await render();
    expect(host.textContent).not.toContain(en.workspaceSwitcher.customizeAccounts);
    const badges = [...host.querySelectorAll("span[title]")].filter((node) => node.textContent === "Cloud" || node.textContent === "Local");
    expect(badges[0].className).toContain("text-blue-700");
    expect(badges[1].className).not.toContain("text-blue-700");
  });
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
