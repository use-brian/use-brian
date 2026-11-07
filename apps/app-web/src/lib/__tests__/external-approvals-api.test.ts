import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
import { authFetch } from "@/lib/auth-fetch";
import { respondByKind } from "../api/approvals";
const fetchMock = vi.mocked(authFetch);
beforeEach(() => fetchMock.mockReset());
describe("[COMP:app-web/approvals] external approval SDK", () => {
  it("uses only the human respond endpoint and strips persistent/attach/reason extras", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "approved" }), { status: 200 }));
    await expect(respondByKind({ id: "external-1", kind: "external_action" }, "approved", "not forwarded", { grantAlways: true, attach: true })).resolves.toEqual({ ok: true, status: "approved" });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/api/approvals/external-1/respond", expect.objectContaining({ method: "POST", body: JSON.stringify({ decision: "approved" }) }));
  });
  it.each(["expired", "superseded", "rejected"])("does not present a lost race (%s) as an approval", async status => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status }), { status: 200 }));
    await expect(respondByKind({ id: "external-1", kind: "external_action" }, "approved")).resolves.toEqual({ ok: false, status: 409, error: "external_approval_changed" });
  });
});
