/** Canonical CRM record route and SDK tests. [COMP:app-web/crm-record-route] */

import { afterEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));

import { fetchCrmRecord, updateCrmRecord, type CrmRecordBundle } from "@/lib/api/crm";
import { crmCollectionHref, crmRecordHref, crmRecordMatchesRoute } from "@/lib/crm-view";

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const bundle: CrmRecordBundle = {
  record: {
    kind: "deal",
    id: "deal-1",
    name: "Launch project",
    stage: "proposal",
    amount: 12_000,
    closeDate: null,
    contactId: "contact-1",
    companyId: null,
    updatedAt: "2026-08-24T00:00:00.000Z",
  },
  relationships: {
    deals: [],
    contacts: [{
      id: "contact-1",
      name: "Jamie Example",
      email: "jamie@example.com",
      phone: null,
      companyId: null,
      tags: [],
      updatedAt: "2026-08-24T00:00:00.000Z",
    }],
    companies: [],
  },
  participants: [{
    contactId: "contact-1",
    role: "Sponsor",
    isPrimary: true,
    name: "Jamie Example",
    email: "jamie@example.com",
  }],
};

afterEach(() => authFetch.mockReset());

describe("[COMP:app-web/crm-record-route] CRM record route", () => {
  it("builds detail and collection URLs without losing the collection lens", () => {
    const search = "section=contacts&filter=orphaned&q=example";
    expect(crmRecordHref("space / one", "contact", "person / one", search)).toBe(
      "/w/space%20%2F%20one/crm/contact/person%20%2F%20one?section=contacts&filter=orphaned&q=example",
    );
    expect(crmCollectionHref("space / one", search)).toBe(
      "/w/space%20%2F%20one/crm?section=contacts&filter=orphaned&q=example",
    );
  });

  it("cold-loads a record bundle independently from the collection", async () => {
    authFetch.mockResolvedValueOnce(response(bundle));
    await expect(fetchCrmRecord("workspace-1", "deal-1")).resolves.toEqual(bundle);
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/crm/workspace-1/records/deal-1"),
    );
  });

  it("rejects a route kind or id mismatch and treats a missing record as absent", async () => {
    expect(crmRecordMatchesRoute(bundle, "contact", "deal-1")).toBe(false);
    expect(crmRecordMatchesRoute(bundle, "deal", "another-deal")).toBe(false);
    authFetch.mockResolvedValueOnce(response({}, 404));
    await expect(fetchCrmRecord("workspace-1", "missing")).resolves.toBeNull();
  });

  it("returns the reconciled server bundle after PATCH and surfaces a failed commit", async () => {
    authFetch
      .mockResolvedValueOnce(response({ ...bundle, record: { ...bundle.record, amount: 15_000 } }))
      .mockResolvedValueOnce(response({ error: "Owner is not active" }, 400));
    await expect(updateCrmRecord("workspace-1", "deal-1", { amount: 15_000 }))
      .resolves.toMatchObject({ record: { amount: 15_000 } });
    expect(authFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/crm/workspace-1/records/deal-1"),
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ amount: 15_000 }) }),
    );
    await expect(updateCrmRecord("workspace-1", "deal-1", { ownerId: "inactive" }))
      .rejects.toThrow("Owner is not active");
  });
});
