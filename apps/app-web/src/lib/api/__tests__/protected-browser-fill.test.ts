import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
import { authFetch } from "@/lib/auth-fetch";
import { createProtectedReferences, protectedScope, safeReferences, protectedReferenceHandoff } from "../protected-browser-fill";
import type { ComputerTask } from "../computer";
const task: ComputerTask = { taskId: "task", workspaceId: "ws", profileId: "profile", backend: "local", status: "running", createdAt: 1, connectionState: "connected", injectedSite: "example.com", destinationOrigin: "https://example.com" };
const referenceId = "a".repeat(43);
const response = () => ({ references: [{ referenceId, field: "email" as const }], expiresAt: Date.now() + 110_000 });
beforeEach(() => vi.clearAllMocks());
describe("[COMP:app-web/protected-fill] trusted metadata boundary", () => {
  it("requires trusted task identity and exact HTTPS origin, never a hostname", () => {
    expect(protectedScope(task, "ws", "session")).toEqual({ taskId: "task", workspaceId: "ws", sessionId: "session", browserProfileId: "profile", destinationOrigin: "https://example.com" });
    for (const patch of [{ destinationOrigin: undefined }, { destinationOrigin: "http://example.com" }, { destinationOrigin: "https://example.com/path" }, { destinationOrigin: "https://user@example.com" }, { profileId: null }, { connectionState: "disconnected" as const }, { backend: "cloud" as const }, { status: "completed" as const }]) {
      expect(protectedScope({ ...task, ...patch }, "ws", "session")).toBeNull();
    }
    expect(protectedScope(task, "other", "session")).toBeNull();
  });
  it("posts only source descriptors and scope to creation, never resolution", async () => {
    vi.mocked(authFetch).mockResolvedValue({ status: 201, json: async () => response() } as Response);
    await createProtectedReferences(protectedScope(task, "ws", "session")!, "contact-id", ["email"]);
    const [url, init] = vi.mocked(authFetch).mock.calls[0];
    expect(url).toBe("https://api.example/api/protected-browser-fill/references");
    expect(JSON.parse(init!.body as string)).toEqual({ ...protectedScope(task, "ws", "session"), sources: [{ kind: "crm", entityId: "contact-id", field: "email" }] });
    expect(init!.cache).toBe("no-store");
  });
  it("strips raw sentinels and record identity from assistant metadata", () => {
    const raw = { ...response(), name: "RAW_SENTINEL", references: [{ referenceId, field: "email", value: "RAW_SENTINEL", entityId: "secret-id" }] };
    const safe = safeReferences(raw, ["email"]);
    expect(protectedReferenceHandoff(safe)).toBe(JSON.stringify({ references: [{ referenceId, field: "email" }] }));
  });
  it("rejects expiry, partial batches, duplicates and injected field labels", () => {
    for (const body of [{ ...response(), expiresAt: 1 }, { ...response(), references: [] }, { ...response(), references: [{ referenceId, field: "RAW_SENTINEL" }] }, { ...response(), references: [{ referenceId: "secret", field: "email" }] }]) {
      expect(() => safeReferences(body, ["email"])).toThrow("Protected fill unavailable");
    }
    expect(() => safeReferences({ ...response(), references: [response().references[0], response().references[0]] }, ["email", "phone"])).toThrow();
  });
  it("never exposes source errors", async () => {
    vi.mocked(authFetch).mockRejectedValue(new Error("RAW_SENTINEL"));
    await expect(createProtectedReferences(protectedScope(task, "ws", "session")!, "contact", ["email"])).rejects.toThrow(/^Protected fill unavailable$/);
  });
});
