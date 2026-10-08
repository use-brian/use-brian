// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ renderBinding: vi.fn() }));
vi.mock("@/lib/api/views", async (importOriginal) => ({ ...(await importOriginal<object>()), renderBinding: api.renderBinding }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "workspace-1" }) }));
vi.mock("@/lib/i18n/client", async () => { const { en } = await import("@/lib/i18n/dictionaries/en"); return { useT: () => en, format: (s: string) => s }; });
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/desktop-auth-source", () => ({ isDesktopAuth: () => false }));
// The interactive table is not under test: print the bound row titles.
vi.mock("../block-data", () => ({
  BlockData: ({ widget }: { widget: { rows?: Array<{ title?: string }> } }) =>
    <div data-rows>{(widget?.rows ?? []).map((row) => row.title).join(",")}</div>,
}));

import { DataEmbed } from "../node-views/embed-view";

const payload = (titles: string[]) => ({ root: { type: "list", columns: [{ field: "title", label: "Title" }], rows: titles.map((title) => ({ title })) } });
let root: Root;
let container: HTMLDivElement;
const binding = { entity: "tasks", viewType: "list" } as never;

async function mount() {
  await act(async () => {
    root.render(<DataEmbed block={{ kind: "data", id: "b1", binding } as never} binding={binding} updateBlock={() => {}} />);
  });
  await act(async () => {});
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  api.renderBinding.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("[COMP:app-web/data-embed] bound rows renew under the content lease", () => {
  it("drops a row the viewer can no longer read on the 15-second renewal, without a reload", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    api.renderBinding.mockResolvedValue(payload(["Fictional Cedar payroll check", "Fictional open task"]));
    await mount();
    expect(container.querySelector("[data-rows]")?.textContent).toContain("Fictional Cedar payroll check");
    // The server reads as the viewer, so a revoked department drops the row.
    api.renderBinding.mockResolvedValue(payload(["Fictional open task"]));
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await act(async () => {});
    expect(container.querySelector("[data-rows]")?.textContent).toBe("Fictional open task");
  });

  it("drops rows unconfirmed for the 30-second lease while online", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    api.renderBinding.mockResolvedValue(payload(["Fictional Cedar payroll check"]));
    await mount();
    api.renderBinding.mockReturnValue(new Promise(() => {}));
    const now = performance.now(); const clock = vi.spyOn(performance, "now").mockReturnValue(now + 31_000);
    try {
      await act(async () => { vi.advanceTimersByTime(5_000); });
      await act(async () => {});
      expect(container.textContent).not.toContain("Fictional Cedar payroll check");
    } finally { clock.mockRestore(); }
  });
});
