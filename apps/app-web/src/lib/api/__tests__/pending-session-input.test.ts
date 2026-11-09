/**
 * [COMP:app-web/pending-questions] Durable current-turn input SDK.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

import { authFetch } from "@/lib/auth-fetch";
import {
  fetchPendingSessionInput,
  toRestoredConfirmation,
} from "../pending-questions";

const mockFetch = vi.mocked(authFetch);

beforeEach(() => mockFetch.mockReset());

describe("[COMP:app-web/pending-questions] pending session input", () => {
  it.each([
    { capability: true, expected: true },
    { capability: false, expected: false },
    { capability: undefined, expected: false },
  ])("restores the shared confirmation card with capability $capability", async ({ capability, expected }) => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          pending: null,
          toolConfirmation: {
            approvalId: "ap-1",
            toolName: "fileWrite",
            input: { path: "plan.md" },
            description: "Write plan.md",
            displayLines: ["File: plan.md"],
            allowPersistentApproval: capability,
            expiresAt: null,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        }),
        { status: 200 },
      ),
    );

    const input = await fetchPendingSessionInput("session/one");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(
      "/api/sessions/session%2Fone/pending",
    );
    expect(input.pending).toBeNull();
    expect(toRestoredConfirmation(input.toolConfirmation!, "session/one")).toEqual({
      toolCallId: "approval:ap-1",
      approvalId: "ap-1",
      restored: true,
      allowPersistentApproval: expected,
      toolName: "fileWrite",
      input: { path: "plan.md" },
      description: "Write plan.md",
      displayLines: ["File: plan.md"],
      sessionId: "session/one",
      status: "pending",
    });
  });

  it("preserves every external request separately from native pending inputs", async () => {
    const pending = { approvalId: "question", question: "Which one?", expiresAt: null, createdAt: null, action: null };
    const toolConfirmation = { approvalId: "tool", toolName: "fileWrite", input: { path: "plan.md" }, description: null, displayLines: [], allowPersistentApproval: true, expiresAt: null, createdAt: null };
    const externalConfirmations = [
      { approvalId: "external-1", title: "Literal <b>title</b>", message: "line one\nline two", options: ["Allow once", "Deny"], expiresAt: "2099-01-01T00:00:00Z" },
      { approvalId: "external-2", title: "Another request", expiresAt: "2099-02-01T00:00:00Z" },
      { approvalId: "external-3", method: "question", title: "Text question", message: "  Literal\n ", expiresAt: "2099-02-01T00:00:00Z" },
      { approvalId: "external-4", method: "question", title: "Choose", options: ["  Literal\t ", "Other"], allowCustom: true, expiresAt: "2099-02-01T00:00:00Z" },
    ];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ pending, toolConfirmation, externalConfirmations })));
    expect(await fetchPendingSessionInput("s1")).toEqual({ pending, toolConfirmation, externalConfirmations });
  });

  it("does not masquerade external requests as native tool confirmations", async () => {
    const externalConfirmations = [{ approvalId: "external-only", title: "Consent", expiresAt: "2099-01-01T00:00:00Z" }];
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ externalConfirmations })));
    expect(await fetchPendingSessionInput("s1")).toEqual({ pending: null, toolConfirmation: null, externalConfirmations });
  });

  it("normalizes missing additive external confirmations for older servers", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ pending: null, toolConfirmation: null })));
    expect(await fetchPendingSessionInput("s1")).toEqual({ pending: null, toolConfirmation: null, externalConfirmations: [] });
  });

  it.each([401, 403, 404])("clears external confirmations when session authority is lost (%s)", async (status) => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status }));
    expect(await fetchPendingSessionInput("s1")).toEqual({ pending: null, toolConfirmation: null, externalConfirmations: [] });
  });

  it("omits external confirmation updates on a transient read failure, preserving mounted cards", async () => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(fetchPendingSessionInput("s1")).resolves.toEqual({
      pending: null,
      toolConfirmation: null,
    });
  });
});
