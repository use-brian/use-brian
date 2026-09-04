// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Channel, ChannelType } from "@/lib/api/channels";
import { syncChannelSlashCommands } from "@/lib/api/channels";
import { ChannelDetail } from "../page";

vi.mock("@/lib/api/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/channels")>();
  return {
    ...actual,
    syncChannelSlashCommands: vi.fn(),
  };
});

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

function channel(
  channelType: ChannelType,
  integrationId: string | null = "integration_1",
): Channel {
  return {
    id: `channel_${channelType}_${integrationId ?? "none"}`,
    workspaceId: "workspace_1",
    channelType,
    clearance: "internal",
    enabledCapabilities: ["chat"],
    status: "active",
    displayName: `${channelType} bot`,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    integrationId,
    config: {},
  };
}

async function renderDetail(value: Channel): Promise<void> {
  await act(async () => {
    root.render(
      localized(
        <ChannelDetail
          key={value.id}
          workspaceId="workspace_1"
          channel={value}
          routing={[]}
          assistants={[]}
          myClearance="internal"
          canRename={false}
          onUpdated={vi.fn()}
          onRoutingChanged={vi.fn()}
          onDeleted={vi.fn()}
        />,
      ),
    );
  });
}

function syncButton(): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find((button) =>
    [
      en.studioPage.channels.slashCommands.sync,
      en.studioPage.channels.slashCommands.syncing,
    ].includes(button.textContent?.trim() ?? ""),
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

describe("[COMP:app-web/studio-channels] Slash command sync", () => {
  it("only renders for integrated Telegram and Discord channels", async () => {
    await renderDetail(channel("telegram"));
    expect(syncButton()).toBeDefined();

    await renderDetail(channel("discord"));
    expect(syncButton()).toBeDefined();

    await renderDetail(channel("telegram", null));
    expect(syncButton()).toBeUndefined();

    await renderDetail(channel("slack"));
    expect(syncButton()).toBeUndefined();
  });

  it("prevents overlapping syncs and shows the returned counts", async () => {
    let resolveSync!: (value: { commandCount: number; omittedCount: number }) => void;
    vi.mocked(syncChannelSlashCommands).mockImplementation(
      () => new Promise((resolve) => {
        resolveSync = resolve;
      }),
    );
    await renderDetail(channel("telegram"));

    const button = syncButton();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(syncChannelSlashCommands).toHaveBeenCalledTimes(1);
    expect(syncChannelSlashCommands).toHaveBeenCalledWith(
      "workspace_1",
      "channel_telegram_integration_1",
    );
    expect(syncButton()?.disabled).toBe(true);
    expect(syncButton()?.textContent).toBe(
      en.studioPage.channels.slashCommands.syncing,
    );

    await act(async () => {
      resolveSync({ commandCount: 7, omittedCount: 2 });
    });

    expect(syncButton()?.disabled).toBe(false);
    expect(host.textContent).toContain("Synced 7 commands. 2 omitted.");
  });

  it("shows an error and allows a safe retry", async () => {
    vi.mocked(syncChannelSlashCommands)
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ commandCount: 4, omittedCount: 0 });
    await renderDetail(channel("discord"));

    await act(async () => syncButton()?.click());
    expect(host.textContent).toContain(en.studioPage.channels.slashCommands.error);
    expect(syncButton()?.disabled).toBe(false);

    await act(async () => syncButton()?.click());
    expect(syncChannelSlashCommands).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain(en.studioPage.channels.slashCommands.error);
    expect(host.textContent).toContain("Synced 4 commands. 0 omitted.");
  });
});
