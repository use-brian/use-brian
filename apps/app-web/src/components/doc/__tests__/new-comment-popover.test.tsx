// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { NewCommentPopover } from "../new-comment-popover";

vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let anchor: HTMLSpanElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  anchor?.remove();
});

async function mount(hasAssistant = true) {
  host = document.createElement("div");
  anchor = document.createElement("span");
  anchor.textContent = "Selected summary";
  document.body.append(host, anchor);
  root = createRoot(host);
  const onSubmit = vi.fn();
  const onDismiss = vi.fn();
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en}>
      <NewCommentPopover anchorEl={anchor} quote="Selected summary"
        workspaceId="ws-fixture" hasAssistant={hasAssistant}
        onSubmit={onSubmit} onDismiss={onDismiss} />
    </I18nProvider>,
  ));
  await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  return { onSubmit, onDismiss };
}
function type(text: string) {
  const input = document.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const aiToggle = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${en.comments.aiReply}"]`)!;
const send = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${en.comments.send}"]`)!;

describe("[COMP:app-web/new-comment-popover] selection draft", () => {
  it("opens and focuses the positioned composer without creating a thread; Escape dismisses", async () => {
    const { onSubmit, onDismiss } = await mount();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Selected summary");
    expect(document.activeElement).toBe(document.querySelector("textarea"));
    expect(aiToggle().getAttribute("aria-pressed")).toBe("false");
    expect(send().disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([false, true])("sends with AI only after explicit opt-in: %s", async (enableAI) => {
    const { onSubmit } = await mount();
    await act(async () => {
      type("Please review this summary");
      if (enableAI) aiToggle().click();
    });
    await act(async () => send().click());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      body: "Please review this summary", aiReply: enableAI,
    }));
  });

  it("keeps comments teammate-only when no assistant is available", async () => {
    const { onSubmit } = await mount(false);
    expect(aiToggle()).toBeNull();
    await act(async () => type("For the team"));
    await act(async () => send().click());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ aiReply: false }));
  });
});
