/**
 * [COMP:app-web/slack-link] Settings -> Account -> Connected accounts ->
 * Slack row - static render contracts (node-only vitest: `renderToString`
 * + module mocks, the domains-section test shape). Effects never run under
 * SSR, so the row is seeded through `initialAccounts`; the code
 * mint/poll/redeem round-trip is web-QA plus the API tests
 * (`[COMP:api/account-route]` slack link-code, `[COMP:api/slack-route]`
 * resolveSlackSender).
 */

import { describe, expect, it, vi } from "vitest";
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

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { SlackLinkRow } from "../account-section";
import { createSlackLinkCode } from "@/lib/api/account";

const dict = en as unknown as Dictionary;
const ta = en.settings.account;

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/slack-link] SlackLinkRow", () => {
  it("unlinked: names the identity mismatch it fixes and offers Connect", () => {
    const html = render(<SlackLinkRow initialAccounts={[]} />);
    expect(html).toContain(ta.slack);
    expect(html).toContain(ta.notConnected);
    expect(html).toContain(ta.connect);
    // The desc is the whole reason the row exists: profile email != sign-in email.
    expect(html).toContain("Slack profile email");
    expect(html).not.toContain(ta.disconnect);
  });

  it("linked: shows the Slack id it is bound to and offers Disconnect", () => {
    const html = render(
      <SlackLinkRow
        initialAccounts={[
          { id: "la-1", provider: "slack", providerId: "U0EXAMPLE", providerMetadata: null, linkedAt: "now" },
          { id: "la-2", provider: "telegram", providerId: "1234", providerMetadata: null, linkedAt: "now" },
        ]}
      />,
    );
    expect(html).toContain("U0EXAMPLE");
    expect(html).toContain(ta.disconnect);
    expect(html).not.toContain(ta.connect + "<");
  });

  it("loading contract when not seeded (the mount effect never runs under SSR)", () => {
    const html = render(<SlackLinkRow />);
    expect(html).toContain(en.settings.common.loading);
  });

  it("every locale carries the Slack copy and none of it uses an em dash", () => {
    for (const d of [en, ja, zh]) {
      const a = d.settings.account;
      for (const key of ["slack", "slackDesc", "connectSlackHint", "slackLinked", "slackUnlinked", "slackUnavailable", "disconnectSlackTitle", "disconnectSlackConfirm"] as const) {
        expect(typeof a[key]).toBe("string");
        expect(a[key]).not.toContain("—");
      }
    }
  });
});

describe("[COMP:app-web/slack-link] createSlackLinkCode", () => {
  it("POSTs /api/account/slack/link-code and returns the code", async () => {
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ code: "SLK123", expiresAt: "2026-06-10T00:05:00Z" }) });
    const out = await createSlackLinkCode();
    expect(out).toEqual({ code: "SLK123", expiresAt: "2026-06-10T00:05:00Z" });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/account\/slack\/link-code$/);
    expect(init.method).toBe("POST");
  });

  it("resolves null on a non-OK response (503 no store / 409 no assistant)", async () => {
    authFetch.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "no_assistant" }) });
    expect(await createSlackLinkCode()).toBeNull();
  });
});
