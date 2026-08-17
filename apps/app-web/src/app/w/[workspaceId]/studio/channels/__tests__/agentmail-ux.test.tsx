// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-channels] AgentMail is configured from its email
 * Channel: required handler, brain ingest, and exact outbound actions.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Channel } from "@/lib/api/channels";
import type { EmailInbox } from "@/lib/api/email-inboxes";
import { AddChannelForm, ChannelDetail } from "../page";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));

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

const channel: Channel = {
  id: "channel_email_1",
  workspaceId: "workspace_1",
  channelType: "email",
  clearance: "internal",
  enabledCapabilities: ["chat", "ingest"],
  status: "active",
  displayName: "hello@agentmail.to",
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  integrationId: "integration_email_1",
  config: {},
};

const inbox: EmailInbox = {
  channelId: channel.id,
  address: "hello@agentmail.to",
  displayName: "Studio inbox",
  status: "active",
  assistantId: "assistant_1",
  accessMode: "allowlist",
  allowlist: ["client@example.com"],
  senderRoutes: [{ email: "client@example.com", assistantId: "assistant_2" }],
  connectorInstanceId: "instance_email_1",
  lastEventAt: null,
  createdAt: "2026-08-14T00:00:00.000Z",
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  authFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes("/api/assistant-connector-grants/assistant_1")) {
      return {
        ok: true,
        json: async () => ({
          grants: [{
            connectorId: "agentmail:instance_email_1",
            allowedActions: ["agentmailSendMessage"],
          }],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("[COMP:app-web/studio-channels] AgentMail Channel UX", () => {
  it("makes the inbox the home for handler, ingest, and outbound actions", async () => {
    await act(async () => {
      root.render(
        localized(
          <ChannelDetail
            workspaceId="workspace_1"
            channel={channel}
            routing={[{
              id: "routing_1",
              channelId: channel.id,
              assistantId: "assistant_1",
              externalSurfaceId: null,
              modelAlias: "standard",
              createdAt: "2026-08-14T00:00:00.000Z",
            }]}
            assistants={[
              { id: "assistant_1", name: "Brian" } as never,
              { id: "assistant_2", name: "Accounts" } as never,
            ]}
            myClearance="confidential"
            onUpdated={vi.fn()}
            onRoutingChanged={vi.fn()}
            onDeleted={vi.fn()}
            emailInbox={inbox}
            onEmailChanged={vi.fn()}
          />,
        ),
      );
    });

    expect(host.textContent).toContain("Handled by default");
    expect(host.textContent).toContain("Who can receive replies?");
    expect(host.textContent).toContain("Approved senders only");
    expect(host.textContent).toContain("Sender routing");
    expect(host.textContent).toContain("client@example.com");
    expect(host.textContent).toContain("Accounts");
    expect(host.textContent).toContain("External senders stay isolated");
    expect(host.textContent).toContain("cannot access workspace memory");
    expect(host.textContent).toContain("Feed this inbox into the brain");
    expect(host.textContent).toContain("Outbound mailbox actions");
    expect(host.textContent).toContain("Send email");
    expect(host.textContent).toContain("Create or schedule drafts");
    expect(host.textContent).not.toContain("Assistant routing");
    expect(host.textContent).not.toContain("Specific channel or chat");

    const sendToggle = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Send email"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(sendToggle?.checked).toBe(true);

    await act(async () => sendToggle?.click());
    const patchCall = authFetch.mock.calls.find(
      ([url, init]) =>
        String(url).includes("agentmail%3Ainstance_email_1") &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(JSON.parse((patchCall?.[1] as RequestInit).body as string)).toEqual({
      readAllowed: true,
      allowedActions: [],
    });
  });

  it("requires a Handled by assistant when creating an email Channel", async () => {
    await act(async () => {
      root.render(
        localized(
          <AddChannelForm
            workspaceId="workspace_1"
            assistants={[{ id: "assistant_1", name: "Brian" } as never]}
            onCreated={vi.fn()}
            onClose={vi.fn()}
            emailConfigured
          />,
        ),
      );
    });

    const emailTab = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim().endsWith("Email"),
    );
    await act(async () => emailTab?.click());

    expect(host.textContent).toContain("Handled by");
    expect(host.textContent).toContain("Required. This assistant answers incoming mail");
    expect(host.textContent).not.toContain("Default assistant");
    expect(host.textContent).not.toContain("None (attach later)");
  });
});
