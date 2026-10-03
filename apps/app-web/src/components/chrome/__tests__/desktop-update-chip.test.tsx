// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { DesktopBridge, DesktopUpdateStatus } from "@/lib/desktop-auth-source";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DesktopUpdateChip } from "../desktop-update-chip";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("[COMP:app-web/desktop-update-chip] DesktopUpdateChip", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let push: ((status: DesktopUpdateStatus | null) => void) | null = null;
  const installUpdate = vi.fn();

  function installBridge(initial: DesktopUpdateStatus | null) {
    window.usebrianDesktop = {
      signIn: () => {},
      getUpdateStatus: () => Promise.resolve(initial),
      onUpdateStatus: (cb) => {
        push = cb;
        return () => {
          push = null;
        };
      },
      installUpdate,
    } satisfies DesktopBridge;
  }

  async function render() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <I18nProvider dict={en} locale="en">
          <DesktopUpdateChip />
        </I18nProvider>,
      );
    });
    await flush();
  }

  beforeEach(() => installUpdate.mockReset());
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    push = null;
    delete window.usebrianDesktop;
  });

  it("renders nothing in a browser (no bridge)", async () => {
    await render();
    expect(host!.innerHTML).toBe("");
  });

  it("renders nothing when the shell has nothing to report", async () => {
    installBridge(null);
    await render();
    expect(host!.querySelector("[data-desktop-update]")).toBeNull();
  });

  it("shows a restart button for a staged update and installs on click", async () => {
    installBridge({ phase: "ready", version: "0.0.10" });
    await render();
    const button = host!.querySelector<HTMLButtonElement>('[data-desktop-update="ready"]');
    expect(button?.textContent).toContain(en.docPage.desktopUpdateReady);
    expect(button?.title).toContain("0.0.10");
    act(() => button!.click());
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });

  it("follows pushes from the shell: downloading, then ready", async () => {
    installBridge(null);
    await render();
    act(() => push!({ phase: "downloading", version: "0.0.10", percent: 42 }));
    expect(host!.querySelector('[data-desktop-update="downloading"]')?.textContent).toContain("42%");
    act(() => push!({ phase: "ready", version: "0.0.10" }));
    expect(host!.querySelector('[data-desktop-update="ready"]')).not.toBeNull();
  });
});
