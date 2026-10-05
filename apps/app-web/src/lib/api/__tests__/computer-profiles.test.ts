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

it.each([
  [401, "anything", "sign_in_required"],
  [403, "computer_profiles_forbidden", "computer_profiles_forbidden"],
  [404, "anything", "api_not_supported"],
  [503, "computer_profiles_schema_unavailable", "computer_profiles_schema_unavailable"],
  [503, "computer_profiles_unavailable", "computer_profiles_unavailable"],
  [503, "native_execution_unavailable", "native_execution_unavailable"],
  [503, "SQL password=secret", "computer_profiles_unavailable"],
  [409, "computer_profiles_duplicate", "computer_profiles_duplicate"],
  [409, "unknown", "computer_profiles_unavailable"],
] as const)("[COMP:app-web/computer-profiles] sanitizes HTTP %s code %s", async (status, code, expected) => {
  vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ code, error: "SQL password=secret" }), { status }));
  for (const request of [() => listComputerProfiles("w"), () => createComputerProfile("w", "Mac"), () => updateComputerProfile("p", { name: "Mac" }), () => updateComputerProfileAssistant("p", "a", { enabled: true }), () => deleteComputerProfile("p")]) {
    await expect(request()).rejects.toMatchObject({ name: "ComputerProfileError", code: expected, status, message: expected });
  }
});
it.each([
  "<html>SQL password=secret</html>", "{}", '{"profiles":{}}',
  JSON.stringify({ profiles: [{ ...profile, enabledAssistantIds: [123] }] }),
  JSON.stringify({ profiles: [{ ...profile, assistantRoutingNotes: { a: { sql: "secret" } } }] }),
  JSON.stringify({ profiles: [{ ...profile, connected: "false" }] }),
  JSON.stringify({ profiles: [{ ...profile, deviceId: undefined }] }),
])("[COMP:app-web/computer-profiles] rejects incompatible list shape %s", async body => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(body));
  await expect(listComputerProfiles("w")).rejects.toMatchObject({ code: "api_not_supported", status: 200 });
});
it("[COMP:app-web/computer-profiles] rejects invalid mutation success and sanitizes network errors", async () => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ profile: { ...profile, canManage: 1 } })));
  await expect(createComputerProfile("w", "Mac")).rejects.toMatchObject({ code: "api_not_supported" });
  vi.mocked(authFetch).mockRejectedValueOnce(new Error("https://secret-token@private-api"));
  await expect(listComputerProfiles("w")).rejects.toMatchObject({ code: "network_unreachable", message: "network_unreachable" });
});
it("[COMP:app-web/computer-profiles] recognizes an HTML proxy response without attributing generic 503 to schema", async () => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response("<html>private</html>", { status: 503, headers: { "Content-Type": "text/html" } }));
  await expect(listComputerProfiles("w")).rejects.toMatchObject({ code: "computer_profiles_unavailable", status: 503 });
});
