import { beforeEach, expect, it, vi } from "vitest";
import { authFetch } from "@/lib/auth-fetch";
import { createComputerProfile, deleteComputerProfile, listComputerProfiles, updateComputerProfile, updateComputerProfileAssistant } from "../computer-profiles";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.test" }) }));
const profile = { id: "p", workspaceId: "w", name: "Mac", enabledAssistantIds: [], assistantRoutingNotes: {}, deviceId: null, connected: false, canManage: true };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ profile, profiles: [profile], ok: true }))); });
it("[COMP:app-web/computer-profiles] authenticates private workspace list and standalone creation", async () => {
  expect(await listComputerProfiles("w & x")).toEqual([profile]);
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles?workspaceId=w+%26+x", { method: "GET", cache: "no-store" });
  expect(await createComputerProfile("w", "Mac")).toEqual(profile);
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles", expect.objectContaining({ method: "POST", body: JSON.stringify({ workspaceId: "w", name: "Mac" }), headers: { "Content-Type": "application/json" } }));
});
it("[COMP:app-web/computer-profiles] updates grants and notes, encodes IDs, and deletes", async () => {
  const patch = { name: "New Mac" };
  expect(await updateComputerProfile("p/1", patch)).toEqual(profile);
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles/p%2F1", expect.objectContaining({ method: "PATCH", body: JSON.stringify(patch) }));
  expect(await updateComputerProfileAssistant("p/1", "a/2", { enabled: false, routingNote: "Design work" })).toEqual(profile);
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles/p%2F1/assistants/a%2F2", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false, routingNote: "Design work" }) }));
  await deleteComputerProfile("p/1");
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles/p%2F1", { method: "DELETE", cache: "no-store" });
});
it.each([401, 403, 404, 500])("[COMP:app-web/computer-profiles] surfaces HTTP %s without treating it as success", async status => {
  vi.mocked(authFetch).mockImplementation(async () => new Response("{}", { status }));
  await expect(listComputerProfiles("w")).rejects.toThrow();
  await expect(createComputerProfile("w", "Mac")).rejects.toThrow();
  await expect(updateComputerProfileAssistant("p", "a", { enabled: true })).rejects.toThrow();
  await expect(deleteComputerProfile("p")).rejects.toThrow();
});
it("[COMP:app-web/computer-profiles] assistant patch projects only atomic intent, never stale whole-profile records", async () => {
  const stale = { enabled: true, enabledAssistantIds: ["revoked"], assistantRoutingNotes: { revoked: "old" } };
  await updateComputerProfileAssistant("p", "b", stale);
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles/p/assistants/b", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }));
  await updateComputerProfileAssistant("p", "b", { routingNote: "" });
  expect(authFetch).toHaveBeenLastCalledWith("https://api.test/api/native-computer/profiles/p/assistants/b", expect.objectContaining({ body: JSON.stringify({ routingNote: "" }) }));
});
