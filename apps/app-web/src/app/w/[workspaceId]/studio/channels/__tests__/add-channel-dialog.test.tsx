// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-channels] "+ Add channel" renders as a modal dialog
 * (`AddChannelDialog`), not an inline card above the master-detail split.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { AddChannelDialog } from "../page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

function localized(node: ReactNode): ReactNode {
  return (
    <I18nProvider locale="en" dict={en}>
      {node}
    </I18nProvider>
  );
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("[COMP:app-web/studio-channels] Add channel dialog", () => {
  it("renders nothing while closed and portals the connect form into a modal when open", async () => {
    const onClose = vi.fn();
    const render = (open: boolean) =>
      act(async () => {
        root.render(
          localized(
            <AddChannelDialog
              open={open}
              onClose={onClose}
              workspaceId="workspace_1"
              assistants={[{ id: "assistant_1", name: "Brian" } as never]}
              onCreated={vi.fn()}
            />,
          ),
        );
      });

    await render(false);
    expect(document.querySelector("[role='dialog']")).toBeNull();
    expect(document.body.textContent).not.toContain(en.studioPage.channels.add.title);

    await render(true);
    const dialog = document.querySelector("[role='dialog']");
    expect(dialog).not.toBeNull();
    // The form portals out of the page tree - it is NOT an inline card in `host`.
    expect(host.textContent).not.toContain(en.studioPage.channels.add.title);
    expect(dialog?.textContent).toContain(en.studioPage.channels.add.title);
    // The platform tabs live inside the popup.
    const tabs = [...(dialog?.querySelectorAll("button") ?? [])].map(
      (b) => b.textContent?.trim() ?? "",
    );
    for (const label of ["Slack", "Telegram", "WeChat"]) {
      expect(tabs.some((tab) => tab.endsWith(label))).toBe(true);
    }

    // The popup owns the close affordance.
    const close = dialog?.querySelector(
      `button[aria-label="${en.studioPage.channels.add.close}"]`,
    ) as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
