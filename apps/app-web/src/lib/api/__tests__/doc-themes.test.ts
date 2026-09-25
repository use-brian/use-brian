import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import { authFetch } from "@/lib/auth-fetch";
import { createDocTheme } from "../doc-themes";

beforeEach(() => vi.resetAllMocks());
describe("[COMP:app-web/doc-themes-sdk] generation", () => {
  it.each([
    ["ocean", { prompt: "ocean" }],
    [{ fromIcon: true }, { fromIcon: true }],
    [{ fromIcon: true, prompt: "dark" }, { fromIcon: true, prompt: "dark" }],
  ] as const)("posts %j without sending icon URLs or bytes", async (input, body) => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ theme: { id: "theme" } })));
    expect(await createDocTheme("ws", input)).toEqual({ id: "theme" });
    expect(authFetch).toHaveBeenCalledWith(expect.stringContaining("/workspaces/ws/doc-themes"), expect.objectContaining({ method: "POST", body: JSON.stringify(body) }));
  });
  it.each([
    [409, "no_workspace_icon", "no_workspace_icon"],
    [422, "unusable_workspace_icon", "unusable_workspace_icon"],
    [422, "theme_model_no_vision", "theme_model_no_vision"],
    [409, "theme_limit_reached", "limit_reached"],
    [422, undefined, "generation_failed"],
  ])("preserves actionable %s %s errors", async (status, code, expected) => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ code }), { status: status as number }));
    await expect(createDocTheme("ws", { fromIcon: true })).rejects.toMatchObject({ code: expected });
  });
});
