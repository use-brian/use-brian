// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-sections] Settings -> Members: the owner can hand
 * the workspace to a member from that member's row menu
 * (workspaces.md -> "Ownership transfer").
 *
 * The row menu goes through the same route and the same type-the-name gate as
 * General -> Advanced. It is offered only to the owner, never on a Personal
 * workspace, and a rejection (e.g. the Free-plan recipient cap) is shown in
 * the server's own words rather than swallowed.
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

import { loadSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { workspaceDetailCacheKey } from "@/lib/surface-prefetch";
import { WorkspaceGeneralSection, WorkspaceMembersSection } from "../workspace-sections";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function detail(opts: { role?: string; isPersonal?: boolean } = {}) {
  return {
    id: "w1",
    name: "Acme",
    purpose: "Ship",
    ownerUserId: "u1",
    isPersonal: opts.isPersonal ?? false,
    role: opts.role ?? "owner",
    members: [
      { userId: "u1", role: "owner", email: "me@example.com", userName: "Me" },
      { userId: "u2", role: "admin", email: "them@example.com", userName: "Casey Example" },
    ],
  };
}

type TransferReply = { ok: boolean; status: number; body: unknown };

/** Invitations and the detail row answer at once; the transfer is controlled per test. */
function routeFetch(transfer: TransferReply = { ok: true, status: 200, body: { ok: true } }) {
  authFetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/invitations")) {
      return { ok: true, json: async () => ({ invitations: [] }) };
    }
    if (url.endsWith("/transfer-ownership")) {
      return { ok: transfer.ok, status: transfer.status, json: async () => transfer.body };
    }
    return { ok: true, json: async () => detail({ role: "admin" }) };
  });
}

const transferCalls = () =>
  authFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/transfer-ownership"));

describe("[COMP:app-web/workspace-sections] transfer ownership from the member row", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetSurfaceCache();
    authFetchMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  async function mount(row: ReturnType<typeof detail>) {
    await loadSurfaceCache(workspaceDetailCacheKey("w1"), async () => row);
    await act(async () => {
      root!.render(<WorkspaceMembersSection />);
      await settle();
    });
  }

  function rowMenuTrigger(): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>(
      'button[aria-label*="Casey Example"]',
    );
  }

  async function openRowMenu() {
    const trigger = rowMenuTrigger();
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.click();
      await settle();
    });
  }

  function menuItem(label: string): HTMLElement | undefined {
    return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (el) => el.textContent?.trim() === label,
    );
  }

  async function confirmWithName(name: string) {
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Acme"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, name);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    });
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Transfer ownership",
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.click();
      await settle();
      await settle();
    });
  }

  it("the owner transfers to a member after typing the workspace name", async () => {
    routeFetch();
    await mount(detail());
    await openRowMenu();

    const item = menuItem("Transfer ownership");
    expect(item).toBeDefined();
    await act(async () => {
      item!.click();
      await settle();
    });
    expect(document.body.textContent).toContain("This makes Casey Example the owner of this workspace");
    // The gate: nothing is sent until the name is typed.
    expect(transferCalls()).toHaveLength(0);

    await confirmWithName("Acme");

    expect(transferCalls()).toHaveLength(1);
    const [url, init] = transferCalls()[0] as [string, RequestInit];
    expect(url).toContain("/api/workspaces/w1/transfer-ownership");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ newOwnerUserId: "u2" });
    // The refetched row makes the caller an admin: the owner-only menus go.
    expect(rowMenuTrigger()).toBeNull();
  });

  it("a rejected transfer shows the server's message", async () => {
    routeFetch({
      ok: false,
      status: 403,
      body: { error: "plan_required", message: "Casey is at the Free workspace limit." },
    });
    await mount(detail());
    await openRowMenu();
    await act(async () => {
      menuItem("Transfer ownership")!.click();
      await settle();
    });
    await confirmWithName("Acme");

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Casey is at the Free workspace limit.");
  });

  it("is offered on a formerly personal workspace", async () => {
    routeFetch();
    await mount(detail({ isPersonal: true }));
    await openRowMenu();

    expect(menuItem("Demote to member")).toBeDefined();
    expect(menuItem("Transfer ownership")).toBeDefined();
  });

  it("General shows deletion and an invitation hint for a signup workspace with one member", async () => {
    const row = detail({ isPersonal: true });
    row.members = row.members.slice(0, 1);
    authFetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...row, templates: [] }) });
    await loadSurfaceCache(workspaceDetailCacheKey("w1"), async () => row);
    await act(async () => { root!.render(<WorkspaceGeneralSection onWorkspaceDeleted={() => {}} />); await settle(); });
    const advanced = Array.from(document.body.querySelectorAll("button")).find(b => b.textContent?.trim() === "Advanced");
    expect(advanced).toBeDefined();
    await act(async () => { advanced!.click(); await settle(); });
    const transfer = Array.from(document.body.querySelectorAll("button")).find(b => b.textContent === "Transfer ownership");
    expect(transfer?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Invite another account through Organization first");
    expect(Array.from(document.body.querySelectorAll("button")).some(b => b.textContent === "Delete workspace")).toBe(true);
    expect(document.body.textContent).not.toContain("Your personal workspace");
  });

  it("a non-owner gets no row menu at all", async () => {
    routeFetch();
    await mount(detail({ role: "admin" }));

    expect(rowMenuTrigger()).toBeNull();
  });
});
