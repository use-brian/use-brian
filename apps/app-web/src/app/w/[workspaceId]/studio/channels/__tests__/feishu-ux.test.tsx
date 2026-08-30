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
import {
  AddChannelForm,
  ChannelConfigSection,
  FEISHU_PERMISSION_IMPORT,
} from "../page";

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
  it("shows a region-aware copy/paste setup guide before app credentials", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

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
    expect(host.textContent).toContain(en.studioPage.channels.add.feishu.guideTitle);
    expect(host.textContent).toContain("im.message.receive_v1");
    expect(host.textContent).toContain("im.message.reaction.created_v1");
    expect(host.textContent).toContain("card.action.trigger");
    expect(host.textContent).toContain(en.studioPage.channels.add.feishu.guideScopeNote);
    expect(host.querySelector('input[placeholder="cli_..."]')).not.toBeNull();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();

    const copyButton = [...host.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.trim() ===
        en.studioPage.channels.add.feishu.copyPermissions,
    );
    expect(copyButton).toBeDefined();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(FEISHU_PERMISSION_IMPORT);
    expect(host.textContent).toContain(
      en.studioPage.channels.add.feishu.permissionsCopied,
    );
  });

  it("keeps ambient all-group access out of the base permission import", () => {
    const imported = JSON.parse(FEISHU_PERMISSION_IMPORT) as {
      scopes: { tenant: string[]; user: string[] };
    };

    expect(imported.scopes.tenant).toEqual(
      expect.arrayContaining([
        "im:message:send_as_bot",
        "im:message:update",
        "im:message.reactions:write_only",
        "im:message.group_at_msg:readonly",
        "im:message.p2p_msg:readonly",
      ]),
    );
    expect(imported.scopes.tenant).not.toContain("im:message.group_msg");
    expect(imported.scopes.user).toEqual([]);
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
