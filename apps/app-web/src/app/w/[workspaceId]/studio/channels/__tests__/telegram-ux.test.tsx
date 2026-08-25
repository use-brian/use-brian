// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-channels] Telegram setup route and settings scope.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { updateChannelConfig, type Channel } from "@/lib/api/channels";
import type { ConfirmOptions } from "@/components/ui/confirm-dialog";
import {
  AddChannelForm,
  ChannelConfigSection,
  normalizeWhatsAppPhoneNumberInput,
  WhatsAppCloudChatSection,
} from "../page";

const confirmDialog = vi.hoisted(() =>
  vi.fn(async (_options: ConfirmOptions) => false),
);

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog }));

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
        allowGuestConnectorTools: true,
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
    expect(cards[0].textContent).toContain("Guest connected tools");
    expect(cards[0].textContent).toContain("Trusted users have full access");
    expect(
      cards[0].querySelector<HTMLInputElement>('input[type="checkbox"]:checked'),
    ).not.toBeNull();
    expect(cards[1].textContent).toContain("Groups only");
    expect(cards[1].textContent).toContain("Require @mention");
    expect(cards[2].textContent).toContain("DMs + groups");
    expect(cards[2].textContent).toContain("Working reaction");
  });

  it("confirms before enabling trusted full access", async () => {
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
        allowedUserIds: ["42"],
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

    const toggle = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Trusted users have full access"));
    expect(toggle).toBeDefined();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(confirmDialog).toHaveBeenCalledWith({
      title: "Give trusted users full access?",
      description: expect.stringContaining("workspace member"),
      confirmLabel: "Give full access",
      cancelLabel: "Cancel",
    });
    const confirmation = confirmDialog.mock.calls.at(-1)?.[0];
    expect(confirmation?.description).toContain("@username");
    expect(confirmation?.description).toContain("stable numeric ID");
  });
});

describe("[COMP:app-web/studio-channels] WhatsApp Cloud access UX", () => {
  it("normalizes allowlist input and renders a persistent chat QR", async () => {
    expect(normalizeWhatsAppPhoneNumberInput("+1 (555) 123-4567")).toBe(
      "15551234567",
    );
    expect(normalizeWhatsAppPhoneNumberInput("0044 20 7946 0958")).toBe(
      "442079460958",
    );
    expect(normalizeWhatsAppPhoneNumberInput("09123 45678")).toBeNull();
    expect(normalizeWhatsAppPhoneNumberInput("555-1234")).toBeNull();

    await act(async () => {
      root.render(
        localized(<WhatsAppCloudChatSection phoneNumber="+1 555 123 4567" />),
      );
    });

    expect(host.textContent).toContain("Chat with this number");
    expect(host.querySelector("svg")).not.toBeNull();
    expect(
      host.querySelector<HTMLAnchorElement>(
        'a[href="https://wa.me/15551234567"]',
      ),
    ).not.toBeNull();
  });

  it("does not describe WhatsApp access as linked Telegram users", async () => {
    const channel: Channel = {
      id: "channel_1",
      workspaceId: "workspace_1",
      channelType: "whatsapp",
      clearance: "internal",
      enabledCapabilities: ["chat"],
      status: "active",
      displayName: "WhatsApp Business",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      integrationId: "integration_1",
      integrationProvider: "cloud_api",
      config: { userAccessMode: "allow_all" },
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

    expect(host.textContent).toContain("Who can message");
    expect(host.textContent).toContain(
      "Anyone who messages this WhatsApp Business number can interact.",
    );
    expect(host.textContent).not.toContain("Linked Telegram users only.");
  });

  it("uses phone-number guidance without a second tool-access toggle", async () => {
    const channel: Channel = {
      id: "channel_1",
      workspaceId: "workspace_1",
      channelType: "whatsapp",
      clearance: "internal",
      enabledCapabilities: ["chat"],
      status: "active",
      displayName: "WhatsApp Business",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      integrationId: "integration_1",
      integrationProvider: "cloud_api",
      config: {
        userAccessMode: "allowlist",
        allowedUserIds: ["15551234567"],
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

    expect(host.textContent).toContain("Only the phone numbers listed below");
    expect(host.textContent).not.toContain("Guest connected tools");
    expect(
      host.querySelector<HTMLInputElement>('input[placeholder="15551234567"]'),
    ).not.toBeNull();
    expect(host.textContent).not.toContain("@userinfobot");
  });

  it("shows a Cloud-only toggle for allowing every group participant", async () => {
    const channel: Channel = {
      id: "channel_1",
      workspaceId: "workspace_1",
      channelType: "whatsapp",
      clearance: "internal",
      enabledCapabilities: ["chat"],
      status: "active",
      displayName: "WhatsApp Business",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
      integrationId: "integration_1",
      integrationProvider: "cloud_api",
      config: {},
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

    expect(host.textContent).toContain("Allow all group participants");
    expect(host.textContent).toContain("Direct messages still follow");
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);

    vi.mocked(updateChannelConfig).mockResolvedValueOnce({
      ...channel,
      config: { whatsappCloudAllowAllGroupMembers: true },
    });
    await act(async () => checkbox?.click());

    expect(updateChannelConfig).toHaveBeenCalledWith(
      "workspace_1",
      "channel_1",
      { whatsappCloudAllowAllGroupMembers: true },
    );
  });
});
