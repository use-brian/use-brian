// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-sections] Settings -> Members invite results say
 * whether each invitation email actually left the server.
 *
 * The invitation row exists whether or not the email sends, so a refused
 * send used to read as an ordinary success: the admin saw "Copy link" and
 * nothing else, and the invitee waited for an email that was never sent.
 * `POST /:workspaceId/invitations` now reports `emailStatus` per address and
 * the result row renders it beside the copy-link fallback.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/user")>()),
  getUserInfo: () => ({ id: "u1", name: "Me", email: "me@example.com" }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ workspaceId: "w1", name: "Acme" }),
  emitWorkspaceIconChanged: vi.fn(),
  emitWorkspaceRenamed: vi.fn(),
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  const { format } = await import("@/lib/i18n/format");
  return { useT: () => en, format };
});

import { en } from "@/lib/i18n/dictionaries/en";
import { loadSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { workspaceDetailCacheKey } from "@/lib/surface-prefetch";
import { WorkspaceMembersSection } from "../workspace-sections";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const DETAIL = {
  id: "w1",
  name: "Acme",
  purpose: "Ship",
  ownerUserId: "u1",
  isPersonal: false,
  role: "owner",
  members: [{ userId: "u1", role: "owner", email: "me@example.com", userName: "Me" }],
};

function routeFetch(inviteResults: unknown[]) {
  authFetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith("/invitations") && init?.method === "POST") {
      return { ok: true, json: async () => ({ results: inviteResults }) };
    }
    if (url.endsWith("/invitations")) {
      return { ok: true, json: async () => ({ invitations: [] }) };
    }
    return { ok: true, json: async () => DETAIL };
  });
}

describe("[COMP:app-web/workspace-sections] invite email status", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(async () => {
    resetSurfaceCache();
    authFetchMock.mockReset();
    await loadSurfaceCache(workspaceDetailCacheKey("w1"), async () => DETAIL);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function invite(emails: string) {
    await act(async () => {
      root!.render(<WorkspaceMembersSection />);
      await settle();
    });
    const textarea = container!.querySelector<HTMLTextAreaElement>(
      `textarea[placeholder="${en.workspaceDetailInline.inviteEmailsPlaceholder}"]`,
    )!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(textarea, emails);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const send = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === en.workspaceDetailInline.sendInvite,
    )!;
    await act(async () => {
      send.click();
      await settle();
    });
  }

  it("names a refused send and keeps the copy-link fallback beside it", async () => {
    routeFetch([
      {
        email: "invitee@example.com",
        status: "invited",
        link: "https://app.example.com/invite?token=t1",
        emailStatus: "failed",
      },
    ]);

    await invite("invitee@example.com");

    const text = container!.textContent ?? "";
    expect(text).toContain(en.workspaceDetailInline.inviteEmailFailed);
    expect(text).not.toContain(en.workspaceDetailInline.inviteEmailSent);
    expect(text).toContain(en.workspaceDetailInline.copyLink);
  });

  it("reports each address in a batch on its own row", async () => {
    routeFetch([
      { email: "sent@example.com", status: "invited", link: "https://x/1", emailStatus: "sent" },
      { email: "off@example.com", status: "invited", link: "https://x/2", emailStatus: "not_configured" },
      { email: "member@example.com", status: "already_member" },
    ]);

    await invite("sent@example.com, off@example.com, member@example.com");

    const text = container!.textContent ?? "";
    expect(text).toContain(en.workspaceDetailInline.inviteEmailSent);
    expect(text).toContain(en.workspaceDetailInline.inviteEmailNotConfigured);
    expect(text).toContain(en.workspaceDetailInline.statusAlreadyMember);
    expect(text).not.toContain(en.workspaceDetailInline.inviteEmailFailed);
  });

  it("renders no email line for a server that predates emailStatus", async () => {
    routeFetch([{ email: "invitee@example.com", status: "invited", link: "https://x/1" }]);

    await invite("invitee@example.com");

    const text = container!.textContent ?? "";
    expect(text).toContain(en.workspaceDetailInline.copyLink);
    expect(text).not.toContain(en.workspaceDetailInline.inviteEmailSent);
    expect(text).not.toContain(en.workspaceDetailInline.inviteEmailFailed);
  });
});
