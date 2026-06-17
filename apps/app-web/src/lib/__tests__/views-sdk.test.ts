/**
 * Pure-logic tests for `lib/api/views.ts`.
 *
 * Real network is not exercised (vitest here is no-DOM unit-only — see
 * vitest.config.ts). The `renderBinding` block mocks `authFetch` to assert the
 * request the SDK *builds* (URL + method + body shape) without a transport.
 *
 * [COMP:app-web/views-sdk]
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the transport so we can assert the request `renderBinding` constructs.
// `vi.hoisted` makes the spy available inside the hoisted `vi.mock` factory.
const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: authFetchMock }));

import { CheckSquare, FileText, Users } from "lucide-react";
import {
  daysUntilPrune,
  derivePageIcon,
  newBlockId,
  renderBinding,
} from "../api/views";

describe("[COMP:app-web/views-sdk] daysUntilPrune", () => {
  it("returns null for a null input (saved view, no prune date)", () => {
    expect(daysUntilPrune(null)).toBeNull();
  });

  it("returns null for an unparseable ISO string", () => {
    expect(daysUntilPrune("not-a-date")).toBeNull();
  });

  it("returns ~30 for a date 30 days in the future", () => {
    const target = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const days = daysUntilPrune(target);
    expect(days).not.toBeNull();
    // Allow ±1 day for sub-millisecond drift inside the calculation.
    expect(Math.abs((days ?? 0) - 30)).toBeLessThanOrEqual(1);
  });

  it("returns 0 or 1 for 'roughly now plus a few hours'", () => {
    const target = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const days = daysUntilPrune(target);
    expect(days).not.toBeNull();
    expect((days ?? 0) <= 1).toBe(true);
    expect((days ?? 0) >= 0).toBe(true);
  });

  it("returns negative for a past prune date", () => {
    const target = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const days = daysUntilPrune(target);
    expect(days).not.toBeNull();
    expect((days ?? 0) < 0).toBe(true);
  });
});

describe("[COMP:app-web/views-sdk] newBlockId", () => {
  it("returns a non-empty string within the 1..128 block-id bound", () => {
    const id = newBlockId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(1);
    expect(id.length).toBeLessThanOrEqual(128);
  });

  it("returns a different id on successive calls (no collision risk in practice)", () => {
    const a = newBlockId();
    const b = newBlockId();
    expect(a).not.toBe(b);
  });
});

describe("[COMP:app-web/views-sdk] renderBinding", () => {
  beforeEach(() => authFetchMock.mockReset());

  it("POSTs the binding UNWRAPPED as the request body", async () => {
    authFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ a2ui: "0.8", root: { type: "table" } }),
    });
    const binding = { entity: "contacts", viewType: "table" } as const;

    await renderBinding("ws-1", binding as never);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/workspaces/ws-1/views/render");
    expect(init.method).toBe("POST");
    // The route validates `req.body` AS the BindingConfig. The body must be
    // the binding itself — a `{ binding }` wrapper fails root validation and
    // surfaces as "Failed to load this data block." on every data embed.
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual(binding);
    expect(sent.binding).toBeUndefined();
  });

  it("throws when the response is not ok", async () => {
    authFetchMock.mockResolvedValue({ ok: false, status: 400 });
    await expect(
      renderBinding("ws-1", { entity: "contacts", viewType: "table" } as never),
    ).rejects.toThrow("renderBinding failed: 400");
  });
});

describe("[COMP:app-web/views-sdk] derivePageIcon", () => {
  it("a fresh placeholder draft is a generic document, not the task icon", () => {
    expect(
      derivePageIcon({
        entity: "tasks",
        viewType: "table",
        nameOrigin: "placeholder",
      }),
    ).toBe(FileText);
  });

  it("a user-renamed draft keeps the document glyph (the bug fix)", () => {
    // Regression: editing the title yourself must NOT flip the draft's icon
    // to the entity (task) glyph. A manual title doesn't make a document a
    // task table — the draft's one icon persists through the rename.
    expect(
      derivePageIcon({
        entity: "tasks",
        viewType: "table",
        nameOrigin: "user",
      }),
    ).toBe(FileText);
  });

  it("a settled auto-titled page with no emoji falls back to its entity glyph", () => {
    expect(
      derivePageIcon({ entity: "tasks", viewType: "table", nameOrigin: "auto" }),
    ).toBe(CheckSquare);
    expect(
      derivePageIcon({
        entity: "contacts",
        viewType: "table",
        nameOrigin: "auto",
      }),
    ).toBe(Users);
  });

  it("a typed view resolved without a page nameOrigin uses its entity glyph", () => {
    // e.g. a `child_page` link passes only { entity, viewType }.
    expect(derivePageIcon({ entity: "contacts", viewType: "table" })).toBe(Users);
  });
});
