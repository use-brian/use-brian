/**
 * [COMP:app-web/feishu-link] Settings -> Account -> Connected accounts ->
 * Feishu/Lark row static render and API wire contracts.
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
import { FeishuLinkRow } from "../account-section";
import { createFeishuLinkCode } from "@/lib/api/account";

const dict = en as unknown as Dictionary;
const account = en.settings.account;

function render(node: React.ReactElement): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feishu-link] FeishuLinkRow", () => {
  it("explains the personal-memory benefit when unlinked", () => {
    const html = render(<FeishuLinkRow initialAccounts={[]} />);
    expect(html).toContain(account.feishu);
    expect(html).toContain("personal memory");
    expect(html).toContain(account.connect);
    expect(html).not.toContain(account.disconnect);
  });

  it("shows the bound Feishu open id when linked", () => {
    const html = render(
      <FeishuLinkRow
        initialAccounts={[
          {
            id: "link-1",
            provider: "feishu",
            providerId: "ou_example",
            providerMetadata: { brand: "lark" },
            linkedAt: "now",
          },
        ]}
      />,
    );
    expect(html).toContain("ou_example");
    expect(html).toContain(account.disconnect);
  });

  it("has complete localized copy without em dashes", () => {
    for (const dictionary of [en, ja, zh]) {
      const values = dictionary.settings.account;
      for (const key of [
        "feishu",
        "feishuDesc",
        "connectFeishuHint",
        "feishuLinked",
        "feishuUnlinked",
        "feishuUnavailable",
        "disconnectFeishuTitle",
        "disconnectFeishuConfirm",
      ] as const) {
        expect(values[key]).not.toContain("—");
      }
    }
  });
});

describe("[COMP:app-web/feishu-link] createFeishuLinkCode", () => {
  it("POSTs the Feishu link-code endpoint", async () => {
    authFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ code: "FSH123", expiresAt: "2026-08-24T01:00:00Z" }),
    });

    await expect(createFeishuLinkCode()).resolves.toEqual({
      code: "FSH123",
      expiresAt: "2026-08-24T01:00:00Z",
    });
    const [url, init] = authFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/account\/feishu\/link-code$/);
    expect(init.method).toBe("POST");
  });
});
