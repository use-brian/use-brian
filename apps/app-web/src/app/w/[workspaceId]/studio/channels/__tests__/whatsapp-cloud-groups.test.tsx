// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  createWhatsAppCloudGroup,
  listWhatsAppCloudGroups,
  type WhatsAppCloudGroup,
} from "@/lib/api/channels";
import { WhatsAppCloudGroupsSection } from "../page";

vi.mock("@/lib/api/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/channels")>();
  return {
    ...actual,
    listWhatsAppCloudGroups: vi.fn(),
    createWhatsAppCloudGroup: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const group = (patch: Partial<WhatsAppCloudGroup>): WhatsAppCloudGroup => ({
  id: "group_1",
  requestId: "request_1",
  providerGroupId: null,
  subject: "Launch team",
  inviteLink: null,
  status: "creating",
  error: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  ...patch,
});

function localized(node: ReactNode): ReactNode {
  return <I18nProvider locale="en" dict={en}>{node}</I18nProvider>;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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

describe("[COMP:app-web/studio-channels] WhatsApp Cloud groups", () => {
  it("renders creating, active, and failed groups with active invite actions", async () => {
    vi.mocked(listWhatsAppCloudGroups).mockResolvedValue([
      group({ id: "creating", subject: "Pending" }),
      group({ id: "active", subject: "Active group", status: "active", providerGroupId: "meta_1", inviteLink: "https://chat.whatsapp.com/invite" }),
      group({ id: "failed", subject: "Failed group", status: "failed", error: "rejected" }),
    ]);

    await act(async () => {
      root.render(localized(<WhatsAppCloudGroupsSection workspaceId="workspace_1" channelId="channel_1" />));
    });

    expect(listWhatsAppCloudGroups).toHaveBeenCalledWith("workspace_1", "channel_1");
    expect(host.textContent).toContain("Group creation is asynchronous");
    expect(host.textContent).toContain("Creating");
    expect(host.textContent).toContain("Active");
    expect(host.textContent).toContain("Failed");
    expect(host.querySelector('a[href="https://chat.whatsapp.com/invite"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Group subject"]')?.maxLength).toBe(128);
  });

  it("POSTs the trimmed subject and inserts the pending group", async () => {
    vi.mocked(listWhatsAppCloudGroups).mockResolvedValue([]);
    vi.mocked(createWhatsAppCloudGroup).mockResolvedValue(group({ subject: "Product launch" }));
    await act(async () => {
      root.render(localized(<WhatsAppCloudGroupsSection workspaceId="workspace_1" channelId="channel_1" />));
    });

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Group subject"]');
    expect(input).not.toBeNull();
    await type(input as HTMLInputElement, "  Product launch  ");
    await act(async () => {
      input?.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(createWhatsAppCloudGroup).toHaveBeenCalledWith("workspace_1", "channel_1", "Product launch");
    expect(host.textContent).toContain("Product launch");
    expect(host.textContent).toContain("Creating");
    expect(input?.value).toBe("");
  });
});
