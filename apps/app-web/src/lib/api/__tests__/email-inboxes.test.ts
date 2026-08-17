/**
 * [COMP:app-web/settings-domains] Assistant-email domain SDK calls keep the
 * workspace-scoped AgentMail lifecycle separate from website-domain routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));

import {
  connectEmailDomain,
  removeEmailDomain,
  verifyEmailDomain,
} from "../email-inboxes";

beforeEach(() => {
  authFetch.mockReset();
});

describe("[COMP:app-web/settings-domains] email domain API", () => {
  it("registers the domain and preserves every returned DNS record", async () => {
    authFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: "domain-1",
        domain: "mail.usebrian.ai",
        status: "pending",
        records: [{
          type: "MX",
          name: "mail.usebrian.ai",
          value: "inbound-smtp.example.net",
          status: null,
          priority: 10,
        }],
      }),
    });

    const result = await connectEmailDomain({
      workspaceId: "workspace-1",
      domain: "mail.usebrian.ai",
    });

    expect(result.records[0]).toEqual(expect.objectContaining({ type: "MX", priority: 10 }));
    expect(authFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/email-inboxes\/domains$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1", domain: "mail.usebrian.ai" }),
      }),
    );
  });

  it("verifies a domain in its workspace", async () => {
    authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    await verifyEmailDomain({ workspaceId: "workspace-1", domainId: "domain/1" });

    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/email-inboxes/domains/domain%2F1/verify"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspaceId: "workspace-1" }),
      }),
    );
  });

  it("removes a domain through the workspace-scoped endpoint", async () => {
    authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });

    await removeEmailDomain({ workspaceId: "workspace/1", domainId: "domain/1" });

    expect(authFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/email-inboxes/domains/domain%2F1?workspaceId=workspace%2F1"),
      { method: "DELETE" },
    );
  });
});
