import { expect, it, vi } from "vitest";
import { fetchNativeContextTasks } from "@/lib/api/native-computer";
import { authFetch } from "@/lib/auth-fetch";
import { nativeContextTasksCacheKey, surfaceDataKey } from "@/lib/surface-prefetch";
const viewer = vi.hoisted(() => ({ id: "one" }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => viewer }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));

it("[COMP:app-web/native-computer] native tasks keys fence viewers and every selected context, not workspace tasks", () => {
  const key = nativeContextTasksCacheKey("w", "a", "c");
  expect(key).not.toBe(surfaceDataKey("tasks", "w"));
  expect(key).not.toBe(nativeContextTasksCacheKey("other", "a", "c"));
  expect(key).not.toBe(nativeContextTasksCacheKey("w", "other", "c"));
  expect(key).not.toBe(nativeContextTasksCacheKey("w", "a", "other"));
  viewer.id = "two";
  expect(key).not.toBe(nativeContextTasksCacheKey("w", "a", "c"));
  expect(key.startsWith("tasks:w:")).toBe(true); // Existing task-event invalidation family.
});
it("[COMP:app-web/native-computer] fetches only native context metadata and fails closed on denial", async () => {
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ tasks: [{ id: "t", title: "Task" }] })));
  expect(await fetchNativeContextTasks("w", "a", "c")).toEqual([{ id: "t", title: "Task" }]);
  const [url, options] = vi.mocked(authFetch).mock.calls.at(-1)!;
  expect(String(url)).toContain("/api/native-computer/context-tasks?workspaceId=w&assistantId=a&conversationId=c");
  expect(options).toEqual({ cache: "no-store" });
  vi.mocked(authFetch).mockResolvedValueOnce(new Response("", { status: 403 }));
  await expect(fetchNativeContextTasks("w", "a", "c")).rejects.toThrow("Native context unavailable");
});
