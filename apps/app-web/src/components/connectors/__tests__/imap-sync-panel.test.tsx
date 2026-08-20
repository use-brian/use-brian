// @vitest-environment jsdom
/**
 * [COMP:web/imap-sync-panel] Company-mailbox card panel — the pure sync-line
 * contract, SSR loading posture, and completed-sync recovery interaction. The
 * loading assertion locks a deliberate hydration guard so the panel renders
 * nothing until the first status poll.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const testMocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  confirmDialog: vi.fn(),
}));

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: testMocks.authFetch,
  getAccessToken: () => null,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: testMocks.confirmDialog,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ImapSyncPanel, formatImapLiveLine, formatImapSyncLine, looksLikeEmailAddress } from "../imap-sync-panel";

const dict = en as unknown as Dictionary;
const tm = en.settings.connectors.imap;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:web/imap-sync-panel] sync line", () => {
  it("shows the archived count without presenting a server estimate as an N-of-M total", () => {
    const line = formatImapSyncLine(
      {
        archived: 8200,
        backfill: { scope: "all", status: "running", totalEstimate: 14200, estimateComplete: false },
      },
      tm,
    );
    expect(line).toContain("8200");
    expect(line).not.toContain("14200");
  });

  it("uses the same honest running line when no estimate exists, and 'up to date' after completion", () => {
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

  it("says the worker is waiting to retry after a transient backfill failure", () => {
    const line = formatImapSyncLine(
      {
        archived: 731,
        backfill: { scope: "all", status: "running", lastError: "connection timeout" },
      },
      tm,
    );
    expect(line).toBe(tm.backfillRetrying.replace("{n}", "731"));
    expect(line).not.toMatch(/ of /);
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

describe("[COMP:web/imap-sync-panel] full-history recovery", () => {
  let host: HTMLDivElement;
  let root: Root;

  const doneStatus = {
    email: "maya@harborlane.example",
    archived: 800,
    backfill: { scope: "all", status: "done" as const, totalEstimate: 1200 },
    lastSyncAt: "2026-08-20T10:17:44.858Z",
    lastError: null,
    ingestionEnabled: false,
    idle: null,
  };

  async function settle() {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }

  beforeEach(async () => {
    testMocks.authFetch.mockReset();
    testMocks.confirmDialog.mockReset().mockResolvedValue(true);
    testMocks.authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/imap/backfill/preflight")) {
        return {
          ok: true,
          json: async () => ({
            folders: [{ path: "INBOX", messages: 1200 }],
            failedFolders: [],
            complete: true,
            total: 1200,
          }),
        };
      }
      if (url.endsWith("/imap/backfill") && init?.method === "POST") {
        return { ok: true, json: async () => ({ ok: true, totalEstimate: 1200, estimateComplete: true }) };
      }
      if (url.includes("/imap/sync-status")) {
        return { ok: true, json: async () => doneStatus };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ImapSyncPanel />
        </I18nProvider>,
      );
    });
    await settle();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps an all-history resync button after done, probes, confirms, then re-arms scope=all", async () => {
    const button = host.querySelector<HTMLButtonElement>("[data-testid='imap-full-history-resync']");
    expect(button?.textContent).toBe(tm.fullResyncBtn);

    await act(async () => button?.click());
    await settle();

    expect(testMocks.confirmDialog).toHaveBeenCalledWith({
      title: tm.fullResyncTitle,
      description: tm.fullResyncDescription.replace("{n}", "1200"),
      confirmLabel: tm.fullResyncConfirm,
      cancelLabel: tm.fullResyncCancel,
    });
    const armCall = testMocks.authFetch.mock.calls.find(
      ([url, init]) => String(url).endsWith("/imap/backfill") && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(armCall).toBeDefined();
    expect(JSON.parse(String((armCall?.[1] as RequestInit).body))).toEqual({ scope: "all" });
  });

  it("keeps the all-history resync button available while the current walk is running", async () => {
    act(() => root.unmount());
    host.remove();
    testMocks.authFetch.mockImplementation(async (url: string) => {
      if (url.includes("/imap/sync-status")) {
        return {
          ok: true,
          json: async () => ({
            ...doneStatus,
            backfill: { scope: "all", status: "running", totalEstimate: 1200 },
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <ImapSyncPanel />
        </I18nProvider>,
      );
    });
    await settle();

    expect(host.querySelector("[data-testid='imap-full-history-resync']")).not.toBeNull();
  });

  it("does not re-arm when the user cancels after the preflight", async () => {
    testMocks.confirmDialog.mockResolvedValueOnce(false);
    const button = host.querySelector<HTMLButtonElement>("[data-testid='imap-full-history-resync']")!;

    await act(async () => button.click());
    await settle();

    expect(testMocks.authFetch.mock.calls.some(
      ([url, init]) => String(url).endsWith("/imap/backfill") && (init as RequestInit | undefined)?.method === "POST",
    )).toBe(false);
  });

  it("uses count-free confirmation copy when the folder probe is incomplete", async () => {
    testMocks.confirmDialog.mockResolvedValueOnce(false);
    testMocks.authFetch.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        folders: [{ path: "INBOX", messages: 97 }],
        failedFolders: [{ path: "Archive" }],
        complete: false,
        total: 97,
      }),
    }));
    const button = host.querySelector<HTMLButtonElement>("[data-testid='imap-full-history-resync']")!;

    await act(async () => button.click());
    await settle();

    expect(testMocks.confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      description: tm.fullResyncDescriptionUnknown,
    }));
    expect(tm.fullResyncDescriptionUnknown).not.toContain("{n}");
  });

  it("has localized, credit-honest recovery copy without em dashes", async () => {
    const { ja } = await import("@/lib/i18n/dictionaries/ja");
    const { zh } = await import("@/lib/i18n/dictionaries/zh");
    for (const d of [en, ja, zh]) {
      const c = d.settings.connectors.imap;
      for (const key of ["fullResyncBtn", "fullResyncArming", "fullResyncTitle", "fullResyncDescription", "fullResyncDescriptionUnknown", "fullResyncConfirm", "fullResyncCancel", "backfillCountsIncomplete"] as const) {
        expect(typeof c[key]).toBe("string");
        expect(c[key]).not.toContain("\u2014");
      }
      expect(c.fullResyncDescription).toContain("{n}");
    }
    expect(tm.fullResyncDescription).toMatch(/No credits are charged/);
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

describe("[COMP:web/imap-sync-panel] live (IDLE) line", () => {
  const fmt = (iso: string) => `T(${iso})`;
  it("says connected + last event, waiting, unsupported, reconnecting, off - and nothing when never watched", () => {
    expect(formatImapLiveLine(null, tm, fmt)).toBeNull();
    expect(formatImapLiveLine(undefined, tm, fmt)).toBeNull();
    expect(formatImapLiveLine({ status: "connected", since: "s", lastEventAt: "2026-08-19T09:41:00Z" }, tm, fmt))
      .toBe("Live: connected. Last new mail at T(2026-08-19T09:41:00Z).");
    expect(formatImapLiveLine({ status: "connected", since: "s", lastEventAt: null }, tm, fmt)).toBe(tm.liveConnectedWaiting);
    expect(formatImapLiveLine({ status: "unsupported", since: "s" }, tm, fmt)).toBe(tm.liveUnsupported);
    expect(formatImapLiveLine({ status: "reconnecting", since: "s", lastError: "closed" }, tm, fmt)).toBe(tm.liveReconnecting);
    expect(formatImapLiveLine({ status: "off", since: "s" }, tm, fmt)).toBe(tm.liveOff);
  });

  it("copy exists in every locale without an em dash", async () => {
    const { ja } = await import("@/lib/i18n/dictionaries/ja");
    const { zh } = await import("@/lib/i18n/dictionaries/zh");
    for (const d of [en, ja, zh]) {
      const c = d.settings.connectors.imap;
      for (const key of ["liveConnected", "liveConnectedWaiting", "liveUnsupported", "liveReconnecting", "liveOff"] as const) {
        expect(typeof c[key]).toBe("string");
        expect(c[key]).not.toContain("\u2014");
      }
      expect(c.liveConnected).toContain("{time}");
    }
  });
});
