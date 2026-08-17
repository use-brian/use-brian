// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-channels] Channel rename.
 *
 * The channel's name is `channels.display_name` — the workspace's own label,
 * seeded from the platform on connect. It rides the same
 * `PATCH /api/workspaces/:workspaceId/channels/:channelId` as clearance and
 * capabilities (`updateChannel`), which has always accepted `displayName`; the
 * panel just had no control for it. These tests pin the control down: it sends
 * the trimmed name, refuses to send a blank or unchanged one (the route's zod
 * is `min(1)`, so a blank submit would 400), and keeps the editor open when the
 * save fails so the typed name isn't lost.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Channel } from "@/lib/api/channels";
import { updateChannel } from "@/lib/api/channels";
import { ChannelDetail } from "../page";

vi.mock("@/lib/api/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/channels")>();
  return {
    ...actual,
    updateChannel: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let host: HTMLDivElement;
let root: Root;

const channel: Channel = {
  id: "channel_1",
  workspaceId: "workspace_1",
  channelType: "telegram",
  clearance: "internal",
  enabledCapabilities: ["chat"],
  status: "active",
  displayName: "Telegram bot",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
  // Null keeps the per-platform config section (which fetches) out of the tree.
  integrationId: null,
  config: null,
};

function localized(node: ReactNode): ReactNode {
  return (
    <I18nProvider locale="en" dict={en}>
      {node}
    </I18nProvider>
  );
}

async function renderDetail(
  onUpdated = vi.fn(),
  canRename = true,
): Promise<void> {
  await act(async () => {
    root.render(
      localized(
        <ChannelDetail
          workspaceId="workspace_1"
          channel={channel}
          routing={[]}
          assistants={[]}
          myClearance="internal"
          canRename={canRename}
          onUpdated={onUpdated}
          onRoutingChanged={vi.fn()}
          onDeleted={vi.fn()}
        />,
      ),
    );
  });
}

/** Open the header's rename editor and return its input. */
async function openEditor(): Promise<HTMLInputElement> {
  const trigger = [...host.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === en.studioPage.channels.rename.action,
  );
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const input = host.querySelector<HTMLInputElement>(
    `input[aria-label="${en.studioPage.channels.rename.placeholder}"]`,
  );
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

/** Type into a controlled React input. */
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.form?.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
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

describe("[COMP:app-web/studio-channels] Channel rename", () => {
  it("PATCHes the trimmed name and closes the editor", async () => {
    const onUpdated = vi.fn();
    vi.mocked(updateChannel).mockResolvedValue({
      ...channel,
      displayName: "Support bot",
    });
    await renderDetail(onUpdated);

    const input = await openEditor();
    expect(input.value).toBe("Telegram bot");
    // Cap mirrors the route's zod `displayName: z.string().min(1).max(200)`.
    expect(input.maxLength).toBe(200);

    await type(input, "  Support bot  ");
    await submit(input);

    expect(updateChannel).toHaveBeenCalledWith("workspace_1", "channel_1", {
      displayName: "Support bot",
    });
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Support bot" }),
    );
    // Editor closed — the header is a heading again.
    expect(host.querySelector("h2")?.textContent).toBe("Telegram bot");
  });

  it("does not call the route for a blank or unchanged name", async () => {
    await renderDetail();

    const input = await openEditor();
    await type(input, "   ");
    await submit(input);
    expect(updateChannel).not.toHaveBeenCalled();
    // Blank keeps the save button unavailable rather than 400ing the route.
    expect(host.querySelector("h2")).not.toBeNull();

    const reopened = await openEditor();
    await type(reopened, "Telegram bot");
    await submit(reopened);
    expect(updateChannel).not.toHaveBeenCalled();
  });

  it("keeps the editor open and shows the error when the save fails", async () => {
    vi.mocked(updateChannel).mockRejectedValue(new Error("Update failed (500)"));
    await renderDetail();

    const input = await openEditor();
    await type(input, "Support bot");
    await submit(input);

    expect(updateChannel).toHaveBeenCalledTimes(1);
    const stillOpen = host.querySelector<HTMLInputElement>(
      `input[aria-label="${en.studioPage.channels.rename.placeholder}"]`,
    );
    expect(stillOpen?.value).toBe("Support bot");
    expect(host.textContent).toContain(en.studioPage.channels.saveError);
  });

  it("offers no rename affordance to a plain member", async () => {
    await renderDetail(vi.fn(), false);

    expect(host.querySelector("h2")?.textContent).toBe("Telegram bot");
    expect(
      [...host.querySelectorAll("button")].find(
        (b) =>
          b.getAttribute("aria-label") === en.studioPage.channels.rename.action,
      ),
    ).toBeUndefined();
    // Not merely hidden — there is no editor in the tree to reach.
    expect(
      host.querySelector(
        `input[aria-label="${en.studioPage.channels.rename.placeholder}"]`,
      ),
    ).toBeNull();
  });

  it("abandons the draft on cancel", async () => {
    await renderDetail();

    const input = await openEditor();
    await type(input, "Support bot");
    const cancel = [...host.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === en.studioPage.channels.rename.cancel,
    );
    await act(async () => {
      cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateChannel).not.toHaveBeenCalled();
    expect(host.querySelector("h2")?.textContent).toBe("Telegram bot");
    // Reopening starts from the stored name, not the abandoned draft.
    expect((await openEditor()).value).toBe("Telegram bot");
  });
});
