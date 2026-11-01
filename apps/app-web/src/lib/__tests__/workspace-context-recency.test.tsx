// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/lib/api/workspaces", () => ({ updateWorkspacePickerPreferences: api.update }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import { WorkspaceContextProvider, type WorkspaceContextValue } from "@/lib/workspace-context";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base: WorkspaceContextValue = {
  workspaceId: "fictional-workspace", name: "Fictional workspace", role: "member",
  clearance: "internal", me: { id: "fictional-viewer" },
};
let host: HTMLDivElement, root: Root;
async function render(value = base, apiUrl = "https://api.example") {
  await act(async () => { root.render(<StrictMode><WorkspaceContextProvider value={value} apiUrl={apiUrl}>
    <button type="button">Fictional workspace control</button>
  </WorkspaceContextProvider></StrictMode>); });
}

describe("[COMP:app-web/workspace-context] workspace entry recency", () => {
  beforeEach(() => {
    api.update.mockReset().mockResolvedValue({});
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it("issues one logical write through effect replay and unchanged context rerenders", async () => {
    api.update.mockImplementation(() => new Promise(() => {}));
    await render();
    await render({ ...base, name: "Fictional renamed workspace" });
    expect(api.update).toHaveBeenCalledExactlyOnceWith(base.workspaceId, { opened: true }, "https://api.example");
    expect(host.querySelector("button")?.disabled).toBe(false);
  });

  it("records real workspace, viewer and API-origin transitions, including a return", async () => {
    await render();
    await render({ ...base, workspaceId: "fictional-second-workspace" });
    await render();
    await render({ ...base, me: { id: "fictional-second-viewer" } });
    await render({ ...base, me: { id: "fictional-second-viewer" } }, "https://other-api.example");
    expect(api.update).toHaveBeenCalledTimes(5);
    expect(api.update.mock.calls.map(call => call[0])).toEqual([
      base.workspaceId, "fictional-second-workspace", base.workspaceId, base.workspaceId, base.workspaceId,
    ]);
    expect(api.update.mock.calls.at(-1)?.[2]).toBe("https://other-api.example");
  });

  it("does not loop after failure and retries on a real remount", async () => {
    api.update.mockRejectedValue(new Error("Fictional offline request"));
    await render();
    await render({ ...base });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Fictional workspace control");
    await act(async () => root.unmount()); root = createRoot(host);
    await render();
    expect(api.update).toHaveBeenCalledTimes(2);
  });
});
