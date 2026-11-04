// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AccountEntry } from "../account-entry";
import { AppSessionProvider } from "../app-session";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import type { DesktopSignInState } from "@/lib/desktop-auth-source";
import type { Dictionary } from "@/lib/i18n/dictionaries";
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
let root: Root, host: HTMLDivElement, notify: (state: DesktopSignInState) => void;
const signIn = vi.fn(), reopen = vi.fn(), cancel = vi.fn();
async function render(dict: Dictionary = en, mode = "signed-out") { await act(async () => root.render(<I18nProvider locale="en" dict={dict}>
  <AppSessionProvider><AccountEntry mode={mode} /></AppSessionProvider>
</I18nProvider>)); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks(); window.usebrianDesktop = { signIn, getSignInState: async () => ({ phase: "idle" }),
    onSignInState: callback => { notify = callback; return () => {}; }, reopenSignIn: reopen, cancelSignIn: cancel,
    listAccounts: async () => ({ accounts: [], canSwitch: true }),
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.usebrianDesktop; });
describe("[COMP:app-web/account-entry] shared account experience", () => {
  it.each([en, ja, zh, zhCN])("uses the active dictionary for reconnect and browser progress", async dict => {
    await render(dict, "reauthenticate"); expect(host.textContent).toContain(dict.desktopSession.reconnectDescription);
    expect(signIn).not.toHaveBeenCalled();
    await act(async () => notify({ phase: "browser", appUrl: "https://brain.example.com" }));
    expect(host.textContent).toContain(dict.desktopSession.browserWaiting); expect(host.textContent).toContain("https://brain.example.com");
    const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
    await act(async () => button(dict.desktopSession.reopenBrowser).click()); expect(reopen).toHaveBeenCalledOnce();
    await act(async () => button(dict.desktopSession.cancel).click()); expect(cancel).toHaveBeenCalledOnce();
  });
  it("shows waiting and failure recovery without a second Cloud sign-in control", async () => {
    await render(); await act(async () => notify({ phase: "exchanging" }));
    expect(host.textContent).toContain(en.desktopSession.finishing);
    expect([...host.querySelectorAll("button")].find(b => b.textContent === en.desktopSession.reopenBrowser)?.disabled).toBe(true);
    await act(async () => notify({ phase: "error" }));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.desktopSession.signInError);
  });
});
