/**
 * [COMP:web/imap-sync-panel] Company-mailbox card panel — the pure sync-line
 * contract and the SSR loading posture (node-only vitest: `renderToString` +
 * module mocks, the models-section test shape). Effects never run under SSR,
 * so the panel renders nothing until the first status poll; the backfill
 * consent round-trip is web-QA.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ImapSyncPanel, formatImapSyncLine, looksLikeEmailAddress } from "../imap-sync-panel";

const dict = en as unknown as Dictionary;
const tm = en.settings.connectors.imap;

describe("[COMP:web/imap-sync-panel] sync line", () => {
  it("shows 'Syncing N of M' while a backfill runs, using the arm-time STATUS ceiling", () => {
    const line = formatImapSyncLine(
      { archived: 8200, backfill: { scope: "all", status: "running", totalEstimate: 14200 } },
      tm,
    );
    expect(line).toContain("8200");
    expect(line).toContain("14200");
  });

  it("falls back to the archived count when the estimate is missing, and to 'up to date' when no backfill runs", () => {
    const running = formatImapSyncLine(
      { archived: 12, backfill: { scope: "12m", status: "running" } },
      tm,
    );
    expect(running).toContain("12");

    const done = formatImapSyncLine(
      { archived: 14200, backfill: { scope: "all", status: "done", totalEstimate: 14200 } },
      tm,
    );
    expect(done).toBe(tm.upToDate.replace("{n}", "14200"));
    expect(formatImapSyncLine({ archived: 0, backfill: null }, tm)).toBe(
      tm.upToDate.replace("{n}", "0"),
    );
  });

  it("reports a parked backfill instead of claiming progress it is not making", () => {
    // Regression for 2026-08-08: a wedged backfill kept `status: "running"`, so
    // this line read "Syncing 72,497 of 155,363..." for twelve days while the
    // count never moved. A progress string with no progress is worse than an
    // error, because it reads as the system working.
    const line = formatImapSyncLine(
      { archived: 72497, backfill: { scope: "all", status: "stalled", totalEstimate: 155363 } },
      tm,
    );
    expect(line).toBe(tm.backfillStalled.replace("{n}", "72497"));
    expect(line).not.toContain("155363");
  });
});

describe("[COMP:web/imap-sync-panel] render posture", () => {
  it("renders nothing before the first status poll (SSR: effects never run)", () => {
    const html = renderToString(
      <I18nProvider locale="en" dict={dict}>
        <ImapSyncPanel />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });
});

describe("[COMP:web/imap-sync-panel] send-as aliases", () => {
  it("looksLikeEmailAddress gates the Add button's round-trip (server re-validates)", () => {
    expect(looksLikeEmailAddress("bd@usebrian.example")).toBe(true);
    expect(looksLikeEmailAddress("  BD@UseBrian.example ")).toBe(true);
    expect(looksLikeEmailAddress("bd@")).toBe(false);
    expect(looksLikeEmailAddress("BD <bd@usebrian.example>")).toBe(false);
    expect(looksLikeEmailAddress("not an address")).toBe(false);
  });

  it("copy is dictionary-backed in every locale, without an em dash, and names the account in the empty state", async () => {
    const { ja } = await import("@/lib/i18n/dictionaries/ja");
    const { zh } = await import("@/lib/i18n/dictionaries/zh");
    for (const d of [en, ja, zh]) {
      const c = d.settings.connectors.imap;
      for (const key of ["sendAsTitle", "sendAsHelp", "sendAsPlaceholder", "sendAsAdd", "sendAsRemove", "sendAsEmpty", "sendAsInvalid", "sendAsFailed"] as const) {
        expect(typeof c[key]).toBe("string");
        expect(c[key]).not.toContain("\u2014");
      }
      expect(c.sendAsEmpty).toContain("{email}");
      expect(c.sendAsRemove).toContain("{addr}");
    }
    expect(tm.sendAsHelp).toMatch(/Send mail as/);
  });
});
