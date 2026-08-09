// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-channels] Telegram setup route and settings scope.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Channel } from "@/lib/api/channels";
import { AddChannelForm, ChannelConfigSection } from "../page";

vi.mock("@/lib/api/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/channels")>();
  return {
    ...actual,
    updateChannelConfig: vi.fn(),
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

describe("[COMP:app-web/studio-channels] Telegram UX", () => {
  it("routes setup through BotFather, token, and assistant with an icon-led path", async () => {
    await act(async () => {
      root.render(
        localized(
          <AddChannelForm
            workspaceId="workspace_1"
            assistants={[{ id: "assistant_1", name: "Brian" } as never]}
            onCreated={vi.fn()}
            onClose={vi.fn()}
          />,
        ),
      );
    });

    const telegramTab = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Telegram",
    );
    expect(telegramTab).toBeDefined();

    await act(async () => {
      telegramTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).toContain("Connect Telegram");
    expect(host.textContent).toContain("Step 1");
    expect(host.textContent).toContain("Open @BotFather");
    expect(host.textContent).toContain("Step 2");
    expect(host.textContent).toContain("Paste token");
    expect(host.textContent).toContain("Step 3");
    expect(host.textContent).toContain("Choose Brian");
    expect(
      host.querySelector('a[href="https://t.me/BotFather"]'),
    ).not.toBeNull();
    expect(host.textContent).not.toContain("privacy mode enabled");
  });

  it("separates DM, group-only, and all-chat controls", async () => {
    const channel: Channel = {
      id: "channel_1",
      workspaceId: "workspace_1",
      channelType: "telegram",
      clearance: "internal",
      enabledCapabilities: ["chat"],
      status: "active",
      displayName: "Telegram bot",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      integrationId: "integration_1",
      config: {
        userAccessMode: "allowlist",
        allowedUserIds: ["@friend"],
        requireMention: true,
        ackReaction: "👀",
      },
    };

    await act(async () => {
      root.render(
        localized(
          <ChannelConfigSection
            workspaceId="workspace_1"
            channel={channel}
            onUpdated={vi.fn()}
          />,
        ),
      );
    });

    const cards = [...host.querySelectorAll("section")];
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain("Access");
    expect(cards[0].textContent).toContain("DMs + groups");
    expect(cards[0].textContent).toContain("Who can DM");
    expect(cards[0].textContent).toContain("Owner + allowlist");
    expect(cards[0].textContent).toContain("@friend");
    expect(cards[1].textContent).toContain("Groups only");
    expect(cards[1].textContent).toContain("Require @mention");
    expect(cards[2].textContent).toContain("DMs + groups");
    expect(cards[2].textContent).toContain("Working reaction");
  });
});
