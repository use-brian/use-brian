// @vitest-environment jsdom
/** [COMP:app-web/memory-context-copy] */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryContextPicker } from "../memory-context-picker";
import { MemoryContextDenied } from "@/lib/api/memory-context";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

const { read, search, report } = vi.hoisted(() => ({ read: vi.fn(), search: vi.fn(), report: vi.fn() }));
vi.mock("@/lib/api/memory-context", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/api/memory-context")>(),
  fetchMemoryContext: read,
  findMemoryContext: search,
  reportMemoryContextCopy: report,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const labels = en.brainPage.memoryContext;
const primary = { summary: "Atlas API migration", detail: "Retain v1 until day 62.\n現行の制約。", updatedAt: "2026-11-18T00:41:00.000Z" };
const expectedText = `${primary.summary}\n\n${primary.detail}\n\nUpdated 2026-11-18`;
const button = (label: string) => Array.from(host.querySelectorAll("button")).find(button => button.textContent === label)!;
let root: Root;
let host: HTMLDivElement;
const writeText = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, "clipboard");
});

async function render(initialId?: string) {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>
    <MemoryContextPicker workspaceId="atlas" initialId={initialId} />
  </I18nProvider>));
}

it("searches the selected workspace, previews one result and copies only its fresh visible text", async () => {
  search.mockResolvedValue([{ id: "one", summary: primary.summary }, { id: "two", summary: "Neighboring record" }]);
  read.mockResolvedValueOnce({ memory: primary }).mockResolvedValueOnce({ memory: primary, receipt: "test-receipt" });
  writeText.mockResolvedValue(undefined);
  await render();
  const input = host.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "migration");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(labels.search).click());
  expect(search).toHaveBeenCalledWith("atlas", "migration", expect.any(AbortSignal));
  await act(async () => button(primary.summary).click());
  expect(host.textContent).toContain(primary.detail);
  await act(async () => button(labels.action).click());
  expect(read.mock.calls.map(call => call.slice(0, 3))).toEqual([["atlas", "one", "preview"], ["atlas", "one", "copy"]]);
  expect(writeText).toHaveBeenCalledExactlyOnceWith(expectedText);
  expect(report).toHaveBeenCalledExactlyOnceWith("test-receipt");
  expect(host.textContent).toContain(labels.copied);
});

it("offers the same text after clipboard denial and records only a copy event for the selected text", async () => {
  read.mockResolvedValueOnce({ memory: primary }).mockResolvedValueOnce({ memory: primary, receipt: "test-receipt" });
  writeText.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
  await render("one");
  await act(async () => button(labels.action).click());
  const input = host.querySelector("textarea")!;
  expect(input.readOnly).toBe(true);
  expect(input.value).toBe(expectedText);
  expect(report).not.toHaveBeenCalled();
  await act(async () => input.dispatchEvent(new Event("copy", { bubbles: true })));
  expect(report).toHaveBeenCalledExactlyOnceWith("test-receipt");
});

it("updates a changed preview before sharing and clears it if current access is denied", async () => {
  read.mockResolvedValueOnce({ memory: primary })
    .mockResolvedValueOnce({ memory: { ...primary, detail: "Retain v1 until day 63." }, receipt: "unused" })
    .mockRejectedValueOnce(new MemoryContextDenied());
  await render("one");
  await act(async () => button(labels.action).click());
  expect(host.textContent).toContain(labels.changed);
  expect(host.textContent).toContain("Retain v1 until day 63.");
  await act(async () => button(labels.action).click());
  expect(host.textContent).toContain(labels.denied);
  expect(host.textContent).not.toContain("Retain v1 until day 63.");
  expect(host.querySelector("textarea")).toBeNull();
  expect(writeText).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});
