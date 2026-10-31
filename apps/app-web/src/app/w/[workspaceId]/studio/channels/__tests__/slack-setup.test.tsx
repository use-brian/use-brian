// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Channel } from "@/lib/api/channels";
import { DISPLAY_API_URL } from "@/lib/display-api-url";
import { ChannelDetail } from "../page-client";

vi.mock("@/lib/display-api-url", () => ({ DISPLAY_API_URL: "https://api.example.com" }));

vi.mock("@/lib/api/account", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/account")>(),
  listLinkedAccounts: vi.fn(async () => []),
  getChannelIdentities: vi.fn(async () => ({
    emailMatches: [], emailMatching: [], emailMatchingVisible: false,
    wechatBindings: [], wechatChannels: [],
  })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const writeText = vi.fn();
const channel: Channel = {
  id: "16dde335-bd8b-4aca-8f55-4b132143e819",
  workspaceId: "workspace_1",
  channelType: "slack",
  clearance: "internal",
  enabledCapabilities: ["chat"],
  status: "active",
  displayName: "Example Slack",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  integrationId: null,
  config: null,
};

async function renderDetail(value = channel) {
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={en}>
        <ChannelDetail
          key={value.id}
          workspaceId={value.workspaceId}
          channel={value}
          routing={[]}
          assistants={[]}
          myClearance="internal"
          canRename={false}
          onUpdated={vi.fn()}
          onRoutingChanged={vi.fn()}
          onDeleted={vi.fn()}
        />
      </I18nProvider>,
    );
  });
}

function copyButton() {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent === en.studioPage.channels.add.copyWebhook,
  );
}

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("[COMP:app-web/studio-channels] Slack event connection recovery", () => {
  it("keeps the exact channel URL available when reopening an existing channel", async () => {
    await renderDetail();

    const expectedUrl = `${DISPLAY_API_URL}/webhook/slack/${channel.id}`;
    expect(host.textContent).toContain(en.studioPage.channels.add.slackWebhookTitle);
    expect(host.textContent).toContain(en.studioPage.channels.add.slackWebhookHint);
    expect(host.querySelector("code")?.textContent).toBe(expectedUrl);
    expect(host.textContent).not.toContain("REPLACE-AFTER-CONNECT");

    await act(async () => copyButton()?.click());
    expect(writeText).toHaveBeenCalledWith(expectedUrl);
    expect(host.textContent).toContain(en.studioPage.channels.add.copied);

    await renderDetail({ ...channel, id: "another_channel", channelType: "telegram" });
    expect(host.textContent).not.toContain(en.studioPage.channels.add.slackWebhookTitle);

    await renderDetail();
    expect(host.querySelector("code")?.textContent).toBe(expectedUrl);
    expect(copyButton()).toBeDefined();
  });

  it("keeps the URL readable and offers manual copying if clipboard access fails", async () => {
    writeText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await renderDetail();

    await act(async () => copyButton()?.click());

    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      en.studioPage.channels.add.slackWebhookCopyError,
    );
    expect(host.querySelector("code")?.textContent).toBe(`${DISPLAY_API_URL}/webhook/slack/${channel.id}`);
    expect(copyButton()).toBeDefined();
  });
});
