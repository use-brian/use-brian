import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
import { authFetch } from "@/lib/auth-fetch";
import { answerExternalQuestion, respondByKind } from "../api/approvals";
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

describe("[COMP:app-web/approvals] external question SDK", () => {
  it("sends only the raw literal answer to the human endpoint", async () => {
    const answer = "  <b>literal</b>\n\t ";
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ kind: "external_action", status: "answered", answer })));
    await expect(answerExternalQuestion("question/1", answer)).resolves.toEqual({ ok: true, status: "answered" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://api.example/api/approvals/question%2F1/respond", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer }) }));
  });
  it.each([
    { kind: "external_action", status: "answered", answer: "someone else's answer" },
    { kind: "external_action", status: "expired", answer: "mine" },
    { kind: "external_action", status: "superseded", answer: "mine" },
    { kind: "external_action", status: "answered" },
    { kind: "question", status: "answered", answer: "mine" },
    {},
  ])("requires exact returned status, kind and answer: %j", async payload => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(answerExternalQuestion("q", "mine")).resolves.toEqual({ ok: false, status: 409, error: "external_approval_changed" });
  });
  it.each([403, 404, 409, 410, 503])("preserves failure status %s", async status => {
    fetchMock.mockResolvedValue(new Response("{}", { status }));
    await expect(answerExternalQuestion("q", "mine")).resolves.toMatchObject({ ok: false, status });
  });
});
