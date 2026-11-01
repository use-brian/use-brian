// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { PageTitle, type CommitFn } from "../property-field";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function render(onCommit: CommitFn<string>, value = "Original title") {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><PageTitle value={value} editable onCommit={onCommit} /></I18nProvider>));
}
function editor() { return host.querySelector("textarea")!; }
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), value);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function save() {
  await act(async () => editor().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
}

describe("[COMP:app-web/brain-property-fields] title save recovery", () => {
  it("keeps a refused title draft for an explicit retry and adopts the confirmed value", async () => {
    const commit = vi.fn<CommitFn<string>>().mockResolvedValueOnce({ ok: false, error: "Temporary save failure" }).mockResolvedValueOnce({ ok: true });
    await render(commit); await type("Revised title"); await save();
    expect(editor().value).toBe("Revised title");
    expect(editor().disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Temporary save failure");
    expect(commit).toHaveBeenCalledTimes(1);
    await save();
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith("Revised title");
    await render(commit, "Revised title");
    expect(editor().value).toBe("Revised title");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await save();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("releases pending state after a transport exception without discarding the draft or retrying", async () => {
    const commit = vi.fn<CommitFn<string>>().mockRejectedValue(new TypeError("Network unavailable"));
    await render(commit); await type("Keep this draft"); await save();
    expect(editor().value).toBe("Keep this draft");
    expect(editor().disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(en.brainPage.detailDrawer.saveFailed);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
