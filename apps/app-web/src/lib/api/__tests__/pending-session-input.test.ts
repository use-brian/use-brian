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
  it("maps a durable tool row into the shared confirmation card shape", async () => {
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
            allowPersistentApproval: false,
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
      toolName: "fileWrite",
      input: { path: "plan.md" },
      description: "Write plan.md",
      displayLines: ["File: plan.md"],
      sessionId: "session/one",
      status: "pending",
    });
  });

  it("fails closed to no restorable input", async () => {
    mockFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(fetchPendingSessionInput("s1")).resolves.toEqual({
      pending: null,
      toolConfirmation: null,
    });
  });
});
