// @vitest-environment jsdom
/**
 * [COMP:app-web/feed-connect-account-dialog] Connect-account dialog —
 * render and recovery contracts.
 *
 * The closed-state checks cover the admin/owner gate and containment. The
 * jsdom interaction checks cover platform-scoped intent plus the failure and
 * cancellation paths that must never strand somebody in `Connecting…`.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";

const workspaceRef = vi.hoisted(
  () => ({ current: null }) as { current: unknown },
);

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(),
  getAccessToken: () => null,
}));
vi.mock("@/contexts/feed-profiles-context", () => ({
  useFeedWorkspace: () => workspaceRef.current,
}));

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { authFetch } from "@/lib/auth-fetch";
import { useConnectAccount } from "../connect-account-dialog";

const dict = en as unknown as Dictionary;
let root: Root | null = null;
let container: HTMLElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
  vi.mocked(authFetch).mockReset();
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function setWorkspace(role: "owner" | "admin" | "member" = "admin") {
  workspaceRef.current = {
    workspaceId: "ws-1",
    name: "Acme Team",
    role,
    canDraft: true,
    me: { id: "u-1" },
    profiles: [],
    refresh: async () => {},
  };
}

async function mountProbe() {
  setWorkspace();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <Probe />
      </I18nProvider>,
    );
  });
}

async function openXDialog() {
  await act(async () => {
    container!
      .querySelector<HTMLButtonElement>("[data-open-twitter]")!
      .click();
    await Promise.resolve();
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function Probe() {
  const { isAdmin, openConnect, dialog } = useConnectAccount();
  return (
    <div>
      <span>{isAdmin ? "can-connect-yes" : "can-connect-no"}</span>
      <button type="button" data-open-twitter onClick={() => void openConnect("twitter")}>
        open-x
      </button>
      {dialog}
    </div>
  );
}

function render(role: "owner" | "admin" | "member"): string {
  setWorkspace(role);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <Probe />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/feed-connect-account-dialog] useConnectAccount", () => {
  it("grants the connect entry point to owners and admins", () => {
    expect(render("owner")).toContain("can-connect-yes");
    expect(render("admin")).toContain("can-connect-yes");
  });

  it("denies it to members", () => {
    expect(render("member")).toContain("can-connect-no");
  });

  it("a closed dialog leaks no copy into the page", () => {
    const html = render("admin");
    expect(html).not.toContain(en.feedPage.connect.title);
    expect(html).not.toContain(en.feedPage.connect.authorize);
  });

  it("locks an X-scoped trigger to X instead of resetting to Threads", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      jsonResponse({ assistants: [] }),
    );
    await mountProbe();
    await openXDialog();

    expect(document.body.textContent).toContain("Connect X");
    expect(document.body.textContent).toContain("Continue to X");
    expect(document.body.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it("restores the action and keeps Cancel available after authorization fails", async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse({
          assistants: [
            {
              id: "voice-1",
              name: "Hinson",
              kind: "app",
              appType: "distribution",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: "X authorization is unavailable." }, 503),
      );
    await mountProbe();
    await openXDialog();

    await act(async () => {
      buttonWithText("Continue to X").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "X authorization is unavailable.",
    );
    expect(buttonWithText("Continue to X").disabled).toBe(false);
    expect(buttonWithText("Cancel").disabled).toBe(false);
  });

  it("lets Cancel abort a pending authorization and close the dialog", async () => {
    let authorizationSignal: AbortSignal | undefined;
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse({
          assistants: [
            {
              id: "voice-1",
              name: "Hinson",
              kind: "app",
              appType: "distribution",
            },
          ],
        }),
      )
      .mockImplementationOnce((_url, init) => {
        authorizationSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          authorizationSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        });
      });
    await mountProbe();
    await openXDialog();

    await act(async () => {
      buttonWithText("Continue to X").click();
      await Promise.resolve();
    });

    expect(buttonWithText("Cancel").disabled).toBe(false);
    expect(document.body.textContent).toContain("Connecting…");

    await act(async () => {
      buttonWithText("Cancel").click();
      await Promise.resolve();
    });

    expect(authorizationSignal?.aborted).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("times out a stalled authorization and restores the retry state", async () => {
    vi.mocked(authFetch)
      .mockResolvedValueOnce(
        jsonResponse({
          assistants: [
            {
              id: "voice-1",
              name: "Hinson",
              kind: "app",
              appType: "distribution",
            },
          ],
        }),
      )
      .mockImplementationOnce((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        }),
      );
    await mountProbe();
    await openXDialog();
    vi.useFakeTimers();

    await act(async () => {
      buttonWithText("Continue to X").click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      en.feedPage.connect.errorTimedOut,
    );
    expect(buttonWithText("Continue to X").disabled).toBe(false);
    expect(buttonWithText("Cancel").disabled).toBe(false);
  });
});
