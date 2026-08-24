// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-channels] Feishu/Lark setup and behavior controls.
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

describe("[COMP:app-web/studio-channels] Feishu/Lark UX", () => {
  it("shows region-aware app credential setup", async () => {
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

    const feishuTab = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Feishu / Lark"),
    );
    expect(feishuTab).toBeDefined();

    await act(async () => {
      feishuTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.textContent).toContain("tenant-owned enterprise app");
    expect(host.textContent).toContain("Feishu China");
    expect(host.querySelector('a[href="https://open.feishu.cn/app"]')).not.toBeNull();
    expect(host.querySelector('input[placeholder="cli_..."]')).not.toBeNull();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("exposes Slack-parity thread, mention, reaction, and access controls", async () => {
    const channel: Channel = {
      id: "channel_1",
      workspaceId: "workspace_1",
      channelType: "feishu",
      clearance: "internal",
      enabledCapabilities: ["chat", "broadcast"],
      status: "active",
      displayName: "Feishu bot",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
      integrationId: "integration_1",
      config: {
        replyInThread: true,
        requireMention: true,
        ackReaction: "👀",
        userAccessMode: "allowlist",
        allowedUserIds: ["ou_example"],
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

    expect(host.textContent).toContain("Reply in thread");
    expect(host.textContent).toContain("Require @mention");
    expect(host.textContent).toContain("Acknowledgment reaction");
    expect(host.textContent).toContain("Allowed users");
    expect(host.textContent).toContain("ou_example");
    expect(host.querySelector('input[placeholder="ou_..."]')).not.toBeNull();
  });
});
