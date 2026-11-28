// @vitest-environment jsdom
import { act, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getComputerFrame, getComputerTask } from "@/lib/api/computer";
import ComputerTakeoverPage from "../[sessionId]/page";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/computer/protected-fill-panel", () => ({ ProtectedFillPanel: () => null }));
vi.mock("@/components/computer/task-discard-button", () => ({ TaskDiscardButton: () => null }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({ computer: { profiles: {}, liveViewTitle: "Live browser", connecting: "Connecting" } }),
}));
vi.mock("@/lib/surface-prefetch", () => ({
  computerTaskCacheKey: (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`,
}));
vi.mock("@/lib/api/computer", () => ({
  getComputerTask: vi.fn(), getComputerFrame: vi.fn(), listBrowserProfiles: vi.fn(async () => []),
}));

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("[COMP:app-web/sandbox-takeover] live frame lifecycle", () => {
  it("paints decoded frames after React replays mount effects", async () => {
    vi.stubGlobal("Image", class { decode = async () => {}; });
    vi.mocked(getComputerTask).mockResolvedValue({
      taskId: "task-1", workspaceId: "workspace-1", profileId: null,
      backend: "local", status: "running", injectedSite: null, createdAt: 1,
    });
    vi.mocked(getComputerFrame).mockResolvedValue({ mimeType: "image/jpeg", data: "AA==" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const params = Promise.resolve({ workspaceId: "workspace-1", sessionId: "session-1" });
    await act(async () => {
      root?.render(
        <StrictMode>
          <Suspense>
            <ComputerTakeoverPage params={params} />
          </Suspense>
        </StrictMode>,
      );
    });
    await act(async () => vi.waitFor(() => expect(getComputerFrame).toHaveBeenCalled()));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AA==");
  });
});
