// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { Locale } from "@/lib/i18n/config";
import type { DesktopBridge, DesktopUpdateStatus } from "@/lib/desktop-auth-source";
import type { OfflineSyncState } from "@/lib/offline/use-offline-sync";
import { WorkspaceStatus } from "../workspace-status";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const healthy: OfflineSyncState = { connectivity: "online", offline: false, reconnecting: false, pending: 0, paused: 0 };
const release = "1.2.3";
const languages = [["en", en], ["ja", ja], ["zh", zh], ["zh-CN", zhCN]] as const;

describe("[COMP:app-web/workspace-status] shared connection and update control", () => {
  let root: Root;
  let host: HTMLDivElement;
  let push: ((status: DesktopUpdateStatus | null) => void) | null;
  const installUpdate = vi.fn();
  const unsubscribe = vi.fn(() => { push = null; });

  function installBridge(initial: DesktopUpdateStatus | null, initialPromise?: Promise<DesktopUpdateStatus | null>) {
    window.usebrianDesktop = {
      signIn: () => {},
      getUpdateStatus: () => initialPromise ?? Promise.resolve(initial),
      onUpdateStatus: (cb) => { push = cb; return unsubscribe; },
      installUpdate,
    } satisfies DesktopBridge;
  }

  async function render(offlineState = healthy, sidebarOpen = true, language: readonly [Locale, Dictionary] = languages[0]) {
    await act(async () => root.render(
      <I18nProvider dict={language[1]} locale={language[0]}>
        <WorkspaceStatus offlineState={offlineState} sidebarOpen={sidebarOpen} />
      </I18nProvider>,
    ));
  }

  const trigger = () => host.querySelector<HTMLButtonElement>("button")!;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const liveText = () => host.querySelector('[role="status"]')!.textContent;
  const state = () => host.querySelector("[data-workspace-status]")!.getAttribute("data-workspace-status");
  async function openDetails() { await act(async () => trigger().click()); }

  beforeEach(() => {
    vi.clearAllMocks();
    push = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.usebrianDesktop;
    vi.unstubAllGlobals();
  });

  it("keeps the Online control in browsers and older shells", async () => {
    await render();
    expect(state()).toBe("online");
    expect(trigger().getAttribute("aria-label")).toBe(en.docPage.offlineStatusOnline);
    window.usebrianDesktop = { signIn: () => {} };
    await render();
    await openDetails();
    expect(dialog().textContent).toBe(en.docPage.offlineStatusOnline);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("replaces the dot with download progress, then an update action in the same control", async () => {
    installBridge(null);
    await render();
    await act(async () => push!({ phase: "downloading", version: release, percent: 42 }));
    expect(state()).toBe("downloading");
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(trigger().getAttribute("aria-label")).toContain("42%");
    await openDetails();
    expect(dialog().textContent).toContain(release);
    expect(dialog().querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
    await act(async () => push!({ phase: "ready", version: release }));
    expect(state()).toBe("ready");
    expect(dialog().querySelector('[role="progressbar"]')).toBeNull();
    expect(dialog().textContent).toContain(en.docPage.desktopUpdateRestart);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("updates an open Online label to real details and back without reopening", async () => {
    installBridge(null);
    await render();
    await openDetails();
    expect(dialog().textContent).toBe(en.docPage.offlineStatusOnline);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    await act(async () => push!({ phase: "downloading", version: release, percent: 42 }));
    expect(dialog().querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("42");
    expect(dialog().textContent).toContain(release);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    await act(async () => push!(null));
    expect(dialog().textContent).toBe(en.docPage.offlineStatusOnline);
    expect(dialog().querySelector('[role="progressbar"]')).toBeNull();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("requires an explicit restart and ignores duplicate clicks", async () => {
    installBridge({ phase: "ready", version: release });
    await render();
    await openDetails();
    expect(installUpdate).not.toHaveBeenCalled();
    const restart = dialog().querySelector<HTMLButtonElement>("button")!;
    expect(restart.textContent).toContain(en.docPage.desktopUpdateRestart);
    await act(async () => { restart.click(); restart.click(); });
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(restart.disabled).toBe(true);
    expect(restart.textContent).toContain(en.docPage.desktopUpdateRestarting);
  });

  it.each([
    [{ offline: true, connectivity: "offline" }, en.docPage.offlineBannerTitle],
    [{ reconnecting: true }, en.docPage.errors.collabReconnecting],
    [{ pending: 2 }, en.docPage.offlineSyncPendingTitle],
    [{ paused: 1 }, en.docPage.offlineSyncPausedTitle],
  ] as const)("prioritizes connection attention while retaining a staged update: %j", async (notice, title) => {
    installBridge({ phase: "ready", version: release });
    await render({ ...healthy, ...notice }, false);
    expect(state()).toBe("attention");
    expect(trigger().getAttribute("aria-label")).toBe(`${title}. ${en.docPage.desktopUpdateReady}`);
    await openDetails();
    expect(dialog().textContent).toContain(title);
    expect(dialog().textContent).toContain(release);
    expect(dialog().textContent).toContain(en.docPage.desktopUpdateRestart);
  });

  it("keeps progress available without re-announcing each percentage", async () => {
    installBridge({ phase: "downloading", version: release, percent: 10 });
    await render();
    const announcement = liveText();
    await act(async () => push!({ phase: "downloading", version: release, percent: 71 }));
    expect(liveText()).toBe(announcement);
    expect(trigger().getAttribute("aria-label")).toContain("71%");
    await act(async () => push!({ phase: "ready", version: release }));
    expect(liveText()).not.toBe(announcement);
  });

  it("does not restore a stale initial update after a newer null push", async () => {
    let resolveInitial!: (status: DesktopUpdateStatus | null) => void;
    installBridge(null, new Promise(resolve => { resolveInitial = resolve; }));
    await render();
    await act(async () => { push!(null); resolveInitial({ phase: "ready", version: release }); });
    expect(state()).toBe("online");
  });

  it("unsubscribes on unmount and ignores a late initial response", async () => {
    let resolveInitial!: (status: DesktopUpdateStatus | null) => void;
    installBridge(null, new Promise(resolve => { resolveInitial = resolve; }));
    await render();
    await act(async () => root.render(null));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => resolveInitial({ phase: "ready", version: release }));
    expect(host.innerHTML).toBe("");
  });
  it.each(languages)("keeps pending counts visible through connection changes until acknowledgement (%s)", async (locale, dict) => {
    const t = dict.docPage;
    const language = [locale, dict] as const;
    await render({ ...healthy, pending: 7 }, true, language);
    await openDetails();
    expect(state()).toBe("attention");
    expect(trigger().getAttribute("aria-label")).toBe(t.offlineSyncPendingTitle);
    const announcement = host.querySelector('[role="status"]')!;
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(announcement.getAttribute("aria-atomic")).toBe("true");
    const pendingDescription = (count: number) => {
      // Identify the rendered description by its interpolated count, rather
      // than pinning a new translation or echoing the dictionary template.
      const description = [...dialog().querySelectorAll("p")]
        .find(p => p.textContent?.includes(String(count)))?.textContent ?? "";
      expect(description).not.toBe("");
      expect(description).not.toContain("{count}");
      expect(liveText()).toContain(description);
      expect(dialog().querySelectorAll("button, a[href]")).toHaveLength(0);
      return description;
    };
    const onlineDescription = pendingDescription(7);

    await render({ ...healthy, connectivity: "offline", offline: true, pending: 7 }, true, language);
    expect(state()).toBe("attention");
    expect(trigger().getAttribute("aria-label")).toBe(t.offlineBannerTitle);
    expect(pendingDescription(7)).not.toBe(onlineDescription);

    await render({ ...healthy, connectivity: "offline", offline: true, pending: 2 }, true, language);
    expect(pendingDescription(2)).not.toContain("7");
    expect(liveText()).not.toContain("7");
    await render({ ...healthy, pending: 2 }, true, language);
    expect(state()).toBe("attention");
    expect(trigger().getAttribute("aria-label")).toBe(t.offlineSyncPendingTitle);
    pendingDescription(2);

    // A connectivity recovery alone leaves pending attention in place. Only
    // the supplied acknowledged-zero state removes that description.
    await render(healthy, true, language);
    expect(state()).toBe("online");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(dialog().textContent).toBe(t.offlineStatusOnline);
    expect(liveText()).toBe(t.offlineStatusOnline);
    expect(dialog().querySelectorAll("button, a[href]")).toHaveLength(0);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it.each(languages)("keeps paused Feed recovery distinct and desktop restart explicit (%s)", async (locale, dict) => {
    const t = dict.docPage;
    installBridge({ phase: "ready", version: release });
    await render({ ...healthy, connectivity: "offline", offline: true, pending: 7, paused: 2 }, true, [locale, dict]);
    await openDetails();
    expect(state()).toBe("attention");
    expect(trigger().getAttribute("aria-label")).toBe(`${t.offlineSyncPausedTitle}. ${t.desktopUpdateReady}`);
    const description = [...dialog().querySelectorAll("p")]
      .find(p => p.textContent?.includes("Feed"))?.textContent ?? "";
    expect(description).toContain("2");
    expect(description).not.toContain("7");
    expect(liveText()).toContain(description);
    const actions = dialog().querySelectorAll<HTMLButtonElement>("button");
    expect(actions).toHaveLength(1);
    expect(actions[0].textContent).toContain(t.desktopUpdateRestart);
    expect(installUpdate).not.toHaveBeenCalled();
    await act(async () => actions[0].click());
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(actions[0].disabled).toBe(true);
  });

});
