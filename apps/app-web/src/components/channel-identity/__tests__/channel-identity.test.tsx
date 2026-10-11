// @vitest-environment jsdom
/**
 * [COMP:app-web/channel-identity] One connect surface for every chat
 * channel: Settings -> Account -> Connected accounts and the Studio channel
 * footer render the same row from the shared registry.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
const authFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
  getAccessToken: () => null,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => false),
}));

import { CHANNEL_IDENTITY } from "@use-brian/shared";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  createChannelLinkCode,
  getChannelIdentities,
  type LinkedAccount,
  type WechatBinding,
} from "@/lib/api/account";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ChannelIdentityFooter,
  ChannelIdentityRow,
  ConnectedAccountsList,
  WechatChannelIdentityRow,
} from "../channel-identity";

const copy = en.settings.account.channelIdentity;
const empty = {
  linked: [], emailMatches: [], emailMatching: [], emailMatchingVisible: false, wechatBindings: [], wechatChannels: [],
};
const feishuLink: LinkedAccount = {
  id: "link-1",
  provider: "feishu",
  providerId: "ou_example",
  providerMetadata: { displayName: "Ada Lovelace" },
  linkedAt: "now",
};

/** renderToString escapes apostrophes. */
const htmlText = (text: string) => text.replaceAll("'", "&#x27;");

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      {node}
    </I18nProvider>,
  );
}

beforeEach(() => authFetch.mockReset());

describe("[COMP:app-web/channel-identity] ConnectedAccountsList (Settings)", () => {
  it("renders a row for every connectable channel and names the rest once", () => {
    const html = render(<ConnectedAccountsList initialData={empty} />);
    for (const label of ["Telegram", "Slack", "Feishu / Lark", "WhatsApp", "WeChat"]) expect(html).toContain(label);
    expect(html).toContain("Not available yet: Discord, Microsoft Teams, Email, Custom channel.");
    // WeChat is channel-scoped: no single global row, only my connections.
    expect(html.match(/data-channel-identity=/g)).toHaveLength(4);
    expect(html).toContain(copy.wechatNone.replaceAll(">", "&gt;"));
  });

  it("shows a linked channel by name with Disconnect, never Connect", () => {
    const html = render(
      <ConnectedAccountsList kinds={["feishu"]} initialData={{ ...empty, linked: [feishuLink] }} />,
    );
    expect(html).toContain("Connected as Ada Lovelace");
    expect(html).toContain(copy.disconnect);
    expect(html).not.toContain(`>${copy.connect}<`);
  });

  it("shows an email match and tells the person a code is only needed if it is wrong", () => {
    const html = render(
      <ConnectedAccountsList
        kinds={["slack"]}
        initialData={{ ...empty, emailMatches: [{ provider: "slack", providerId: "U1", displayName: "ada" }] }}
      />,
    );
    expect(html).toContain("Matched by email as ada");
    expect(html).toContain("only if it picked the wrong account");
  });

  it("explains automatic email matching on an unconnected email-matching channel", () => {
    const html = render(<ConnectedAccountsList kinds={["feishu"]} initialData={empty} />);
    expect(html).toContain(copy.notConnected);
    expect(html).toContain(copy.emailAutoHint);
    expect(html).toContain(copy.connect);
  });
});

describe("[COMP:app-web/channel-identity] ChannelIdentityRow connecting state", () => {
  it("shows the code, the channel-specific instruction and the move warning", () => {
    const html = render(
      <ChannelIdentityRow
        descriptor={CHANNEL_IDENTITY.feishu}
        linked={null}
        emailMatch={null}
        initialCode={{ code: "X5A4FF", expiresAt: new Date(Date.now() + 600_000).toISOString() }}
      />,
    );
    expect(html).toContain("X5A4FF");
    expect(html).toContain(copy.howTo.feishu);
    expect(html).toContain(copy.movesHere);
  });

  it("builds the Telegram deep link from the minted code", () => {
    const html = render(
      <ChannelIdentityRow
        descriptor={CHANNEL_IDENTITY.telegram}
        linked={null}
        emailMatch={null}
        initialCode={{ code: "ABC123", expiresAt: new Date(Date.now() + 600_000).toISOString(), botUsername: "example_bot" }}
      />,
    );
    expect(html).toContain("https://t.me/example_bot?start=ABC123");
    expect(html).toContain(copy.openTelegram);
  });
});

describe("[COMP:app-web/channel-identity] ChannelIdentityFooter (Studio channel)", () => {
  it("says honestly that a channel without a claim handler cannot connect yet", () => {
    const html = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-1", channelType: "discord" }}
        workspaceId="ws-1"
        initialData={empty}
      />,
    );
    expect(html).toContain(copy.footerTitle);
    expect(html).toContain(htmlText(copy.unavailable));
    expect(html).not.toContain(`>${copy.connect}<`);
  });

  it("treats a WhatsApp Cloud API channel as unavailable", () => {
    const html = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-1", channelType: "whatsapp", integrationProvider: "cloud_api" }}
        workspaceId="ws-1"
        initialData={empty}
      />,
    );
    expect(html).toContain(htmlText(copy.unavailable));
  });

  it("shows an admin the permissions to grant when email matching is off", () => {
    const html = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-1", channelType: "feishu" }}
        workspaceId="ws-1"
        initialData={{
          ...empty,
          emailMatchingVisible: true,
          emailMatching: [{
            channelId: "ch-1",
            status: "off",
            reason: "lookup_denied",
            missingScopes: ["contact:contact.base:readonly", "contact:user.email:readonly"],
            providerCode: "99991672",
            at: "2026-10-02T00:00:00Z",
          }],
        }}
      />,
    );
    expect(html).toContain("Off. This Feishu / Lark app can&#x27;t read member emails");
    expect(html).toContain(copy.emailMatchingFix);
    expect(html).toContain("contact:contact.base:readonly, contact:user.email:readonly");
  });

  it("shows an admin that status is pending before any lookup, and hides it from members", () => {
    const admin = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-1", channelType: "feishu" }}
        workspaceId="ws-1"
        initialData={{ ...empty, emailMatchingVisible: true }}
      />,
    );
    expect(admin).toContain(copy.emailMatchingUnknown);
    const member = render(
      <ChannelIdentityFooter channel={{ id: "ch-1", channelType: "feishu" }} workspaceId="ws-1" initialData={empty} />,
    );
    expect(member).not.toContain(copy.emailMatchingTitle);
  });
});

describe("[COMP:app-web/channel-identity] status line only where the route reports it", () => {
  it("shows no email-matching line on Slack, whose route does not report a status", () => {
    const html = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-1", channelType: "slack" }}
        workspaceId="ws-1"
        initialData={{ ...empty, emailMatchingVisible: true }}
      />,
    );
    expect(html).not.toContain(copy.emailMatchingTitle);
  });
});

describe("[COMP:app-web/channel-identity] API wire contracts", () => {
  it("mints a code by POSTing to the registry endpoint", async () => {
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ code: "ABC123", expiresAt: "x" }) });
    const code = await createChannelLinkCode(CHANNEL_IDENTITY.slack.codeEndpoint!);
    expect(code?.code).toBe("ABC123");
    expect(String(authFetch.mock.calls[0][0])).toContain("/api/account/slack/link-code");
    expect(authFetch.mock.calls[0][1]).toEqual({ method: "POST" });
  });

  it("returns null when this installation cannot mint a code", async () => {
    authFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await createChannelLinkCode(CHANNEL_IDENTITY.whatsapp.codeEndpoint!)).toBeNull();
  });

  it("reads channel identities scoped to the workspace and defaults safely", async () => {
    authFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    expect(await getChannelIdentities("ws-1")).toEqual({
      emailMatches: [], emailMatching: [], emailMatchingVisible: false, wechatBindings: [], wechatChannels: [],
    });
    expect(String(authFetch.mock.calls[0][0])).toContain("/api/account/channel-identities?workspaceId=ws-1");
  });
});

// ── WeChat: channel-scoped rows (A12) ───────────────────────────────

const WS = "00000000-0000-4000-a000-0000000000aa";
const wechatBinding = (i: number, state: WechatBinding["state"] = "linked"): WechatBinding => ({
  bindingId: `00000000-0000-4000-b000-${String(i).padStart(12, "0")}`,
  workspaceId: WS,
  channelId: `00000000-0000-4000-c000-${String(i).padStart(12, "0")}`,
  channelName: `WeChat bot ${i}`,
  state,
  linkedAt: "2026-10-11T00:00:00.000Z",
  revokedAt: null,
});

describe("[COMP:app-web/channel-identity] WeChat connections (channel-scoped)", () => {
  it("Settings lists each of my twelve WeChat connections as its own row", () => {
    const bindings = Array.from({ length: 12 }, (_, i) => wechatBinding(i + 1));
    const html = render(<ConnectedAccountsList kinds={["wechat"]} initialData={{ ...empty, wechatBindings: bindings }} />);
    expect(html.match(/data-wechat-channel=/g)).toHaveLength(12);
    expect(html.match(/data-state="linked"/g)).toHaveLength(12);
    for (const b of bindings) expect(html).toContain(b.channelName!);
    expect(html).not.toContain(copy.wechatNone.replaceAll(">", "&gt;"));
  });

  it("names every state with an actionable path, never another account", () => {
    const cases: Array<[WechatBinding["state"], string, string | null]> = [
      ["access_removed", copy.wechatAccessRemoved, copy.disconnect],
      ["pairing_replaced", copy.wechatPairingReplaced, copy.wechatLinkAgain],
      ["revoked", copy.wechatRevoked, copy.wechatLinkAgain],
    ];
    for (const [state, text, action] of cases) {
      const html = render(<ConnectedAccountsList kinds={["wechat"]} initialData={{ ...empty, wechatBindings: [wechatBinding(1, state)] }} />);
      expect(html).toContain(htmlText(text));
      if (action) expect(html).toContain(action);
    }
  });

  it("the Studio footer offers a scoped link to a member with no binding and hides the admin summary", () => {
    const html = render(
      <ChannelIdentityFooter channel={{ id: "ch-w", channelType: "wechat", displayName: "Front desk bot" }} workspaceId={WS} initialData={empty} />,
    );
    expect(html).toContain(copy.wechatNotLinked);
    expect(html).toContain(`>${copy.wechatLink}<`);
    expect(html).not.toContain(en.studioPage.channels.wechat.identityTitle);
  });

  it("an admin sees linked/unlinked/conflict per channel, with revoke or the staff link", () => {
    const wc = en.studioPage.channels.wechat;
    const linked = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-w", channelType: "wechat" }}
        workspaceId={WS}
        initialData={{ ...empty, emailMatchingVisible: true, wechatChannels: [{
          channelId: "ch-w", channelName: "Bot", state: "linked", account: { id: "u", name: "Sam Example", email: null }, linkedAt: "x",
        }] }}
      />,
    );
    expect(linked).toContain("Linked to Sam Example.");
    expect(linked).toContain(wc.revokeBinding);
    const unlinked = render(
      <ChannelIdentityFooter
        channel={{ id: "ch-w", channelType: "wechat" }}
        workspaceId={WS}
        initialData={{ ...empty, emailMatchingVisible: true, wechatChannels: [{
          channelId: "ch-w", channelName: "Bot", state: "unlinked", account: null, linkedAt: null,
        }] }}
      />,
    );
    expect(unlinked).toContain(wc.stateUnlinked);
    expect(unlinked).toContain(wc.copyStaffLink);
    expect(unlinked).not.toContain(wc.revokeBinding);
  });

  it("linking mints a scoped code, shows the LINK command, and turns linked when the binding appears", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const channelId = "00000000-0000-4000-c000-000000000009";
    authFetch.mockImplementation(async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).endsWith("/api/account/wechat/link-code")) {
        expect(JSON.parse(init!.body!)).toEqual({ workspaceId: WS, channelId });
        return new Response(JSON.stringify({ code: "ABCDEFGH", expiresAt: new Date(Date.now() + 900_000).toISOString(), channelName: "Bot" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ...empty, wechatBindings: [{ ...wechatBinding(9), channelId }] }), { status: 200 });
    });
    const onChanged = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <WechatChannelIdentityRow workspaceId={WS} channelId={channelId} channelName="Bot" binding={null} onChanged={onChanged} pollMs={5} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((b) => b.textContent === copy.wechatLink)!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("ABCDEFGH");
    expect(container.textContent).toContain("LINK ABCDEFGH");
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(onChanged).toHaveBeenCalled();
    expect(container.textContent).toContain(copy.wechatLinkedNotice);
    act(() => root.unmount());
    container.remove();
  });

  it("a channel held by another account shows that state without naming the account", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    authFetch.mockResolvedValue(new Response(JSON.stringify({ error: "linked_elsewhere", code: "linked_elsewhere" }), { status: 409 }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider locale="en" dict={en as unknown as Dictionary}>
          <WechatChannelIdentityRow workspaceId={WS} channelId="ch" channelName="Bot" binding={null} />
        </I18nProvider>,
      );
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((b) => b.textContent === copy.wechatLink)!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain(copy.wechatLinkedElsewhere);
    expect(container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("linked_elsewhere");
    act(() => root.unmount());
    container.remove();
  });
});
