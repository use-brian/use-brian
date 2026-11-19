// @vitest-environment jsdom
/** [COMP:app-web/memory-bulk-export] */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryExport } from "../memory-export";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const download = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/brain", () => ({ fetchMemoryExport: download }));
vi.mock("@/lib/primary-auth", () => ({ webAppUrl: () => "https://brian.example" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = en.brainPage.memoryExport;
let host: HTMLDivElement;
let root: Root;
let clearRequest: ReturnType<typeof vi.fn>;
const button = (text: string) => Array.from(document.querySelectorAll("button")).find(node => node.textContent === text)!;
async function render(requestedFormat: "csv" | null = null, offline = false) {
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en}>
      <MemoryExport workspaceId="atlas" workspaceName="Fictional Atlas" requestedFormat={requestedFormat}
        showTrigger offline={offline} clearRequest={clearRequest} />
    </I18nProvider>,
  ));
}

beforeEach(() => {
  clearRequest = vi.fn();
  download.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("workspace Memory export dialog", () => {
  it("opens from Brain, selects a format, and scopes plan checkout to the current workspace", async () => {
    download.mockResolvedValue({ kind: "upgrade", canManageBilling: true });
    await render();
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${t.title}"]`)!.click());
    expect(document.body.textContent).toContain("Fictional Atlas");
    await act(async () => button(t.csv).click());
    await act(async () => button(t.download).click());
    expect(download).toHaveBeenCalledWith("atlas", "csv", expect.any(AbortSignal));
    expect(document.querySelector("a")?.href).toBe("https://brian.example/plans?workspaceId=atlas");
  });

  it("honors an agent’s format and cancels the live request when dismissed", async () => {
    download.mockImplementation(() => new Promise(() => {}));
    await render("csv");
    expect(button(t.csv).getAttribute("aria-pressed")).toBe("true");
    await act(async () => button(t.download).click());
    const signal = download.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => button(t.cancel).click());
    expect(signal.aborted).toBe(true);
    expect(clearRequest).toHaveBeenCalledOnce();
  });

  it("gives non-owners a clear upgrade handoff and keeps downloads disabled while offline", async () => {
    await render("csv", true);
    expect(button(t.download).disabled).toBe(true);
    await render("csv");
    download.mockResolvedValue({ kind: "upgrade", canManageBilling: false });
    await act(async () => button(t.download).click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(t.askOwner);
    expect(document.querySelector("a")).toBeNull();
  });
});
