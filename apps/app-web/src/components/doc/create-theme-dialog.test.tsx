// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { DocThemeError } from "@/lib/api/doc-themes";
const state = vi.hoisted(() => ({ iconUrl: null as string | null, createTheme: vi.fn(), generating: false }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => state }));
vi.mock("@/lib/custom-themes", () => ({ useCustomThemes: () => state }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
import { CreateThemeDialog } from "./create-theme-dialog";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
async function render(open = true) { await act(async () => root.render(<CreateThemeDialog open={open} onOpenChange={close} />)); }
function generate() { return [...document.querySelectorAll("button")].find(b => b.textContent === en.settings.general.customThemeGenerate)!; }
async function click(el: HTMLElement) { await act(async () => el.click()); }
beforeEach(() => {
  state.iconUrl = null; state.generating = false; state.createTheme.mockReset(); close.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe("[COMP:app-web/create-theme-dialog] workspace icon", () => {
  it("hides the option without an uploaded icon and requires text", async () => {
    await render(); expect(document.querySelector('[role="checkbox"]')).toBeNull(); expect(generate().disabled).toBe(true);
  });
  it("submits the stored icon without a prompt and resets on reopen", async () => {
    state.iconUrl = "/api/workspace-icons/ws"; await render();
    await click(document.querySelector('[role="checkbox"]')!);
    expect(generate().disabled).toBe(false); await click(generate());
    expect(state.createTheme).toHaveBeenCalledWith({ fromIcon: true }); expect(close).toHaveBeenCalledWith(false);
    await render(false); await render(); expect(generate().disabled).toBe(true);
  });
  it.each([['no_workspace_icon', 'customThemeNoIcon'], ['unusable_workspace_icon', 'customThemeUnusableIcon'], ['theme_model_no_vision', 'customThemeNoVision']] as const)("renders %s with a remedy", async (code, key) => {
    state.iconUrl = "/icon"; state.createTheme.mockRejectedValue(new DocThemeError(code, "server message"));
    await render(); await click(document.querySelector('[role="checkbox"]')!); await click(generate());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(en.settings.general[key]); expect(close).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves prompt guidance (icon=%s)", async (icon) => {
    state.iconUrl = "/icon"; await render();
    if (icon) await click(document.querySelector('[role="checkbox"]')!);
    const textarea = document.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "  softer blues  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(generate());
    expect(state.createTheme).toHaveBeenCalledWith(icon ? { fromIcon: true, prompt: "softer blues" } : "softer blues");
  });
  it("locks generation controls while a request is pending", async () => {
    state.iconUrl = "/icon"; state.generating = true; await render();
    expect(document.querySelector("textarea")!.disabled).toBe(true);
    expect(document.querySelector('[role="checkbox"]')!.getAttribute("aria-disabled")).toBe("true");
    expect([...document.querySelectorAll("button")].filter(b => b.textContent === en.common.cancel || b.textContent === en.settings.general.customThemeGenerating).every(b => b.disabled)).toBe(true);
  });
  it("disables icon generation if the uploaded icon disappears", async () => {
    state.iconUrl = "/icon"; await render(); await click(document.querySelector('[role="checkbox"]')!);
    state.iconUrl = null; await render(); expect(generate().disabled).toBe(true);
  });
});
