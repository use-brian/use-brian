// @vitest-environment jsdom
/** [COMP:app-web/question-answer-form] */
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuestionAnswerForm } from "../question-answer-form";
import { en } from "@/lib/i18n/dictionaries/en";

const t = en.chat.pendingQuestion;
let host: HTMLDivElement, root: Root;
const submit = vi.fn();
function Harness(props: Partial<React.ComponentProps<typeof QuestionAnswerForm>>) {
  const [value, setValue] = useState("");
  return <QuestionAnswerForm dict={t} value={value} onChange={setValue} onSubmit={submit} canSubmit={!!value.trim()} {...props} />;
}
const render = async (props = {}) => { await act(async () => root.render(<Harness {...props} />)); };
const type = async (value: string) => {
  await act(async () => {
    const input = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
beforeEach(() => {
  submit.mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("[COMP:app-web/question-answer-form] native presentation without transport", () => {
  it("has controlled compact input, label, native copy, growing height and a 44px Send button", async () => {
    await render();
    const input = host.querySelector("textarea")!;
    expect(host.textContent).toContain(t.heading);
    expect(input.placeholder).toBe(t.placeholder);
    expect(input.rows).toBe(2);
    expect(input.className).toContain("text-[16px]");
    expect(input.className).toContain("max-h-40");
    expect(host.querySelector("label")?.htmlFor).toBe(input.id);
    const send = host.querySelector("button")!;
    expect(send.textContent).toBe(t.submit);
    expect(send.className).toContain("min-h-11");
    expect(send.disabled).toBe(true);
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 96 });
    await type("one\ntwo");
    expect(input.value).toBe("one\ntwo"); expect(input.style.height).toBe("96px");
    await act(async () => send.click()); expect(submit).toHaveBeenCalledTimes(1);
  });
  it("sends Enter, but not Shift+Enter or an IME composition", async () => {
    await render(); await type("answer");
    const input = host.querySelector("textarea")!;
    for (const options of [{ shiftKey: true }, { isComposing: true }]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
      await act(async () => { input.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(submit).not.toHaveBeenCalled();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true); expect(submit).toHaveBeenCalledTimes(1);
  });
  it.each([{ disabled: true }, { submitting: true }, { canSubmit: false }])("guards button and Enter when %o", async props => {
    await render(props); await type("answer");
    expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => {
      host.querySelector("button")!.click();
      host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(submit).not.toHaveBeenCalled();
    if ("submitting" in props) expect(host.textContent).toContain(t.submitting);
  });
  it.each([[false, false, false], [true, false, true], [true, true, false]])("autofocus opt-in %s, phone %s => %s", async (autoFocus, phone, focused) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: phone })));
    await render({ autoFocus });
    expect(document.activeElement === host.querySelector("textarea")).toBe(focused);
  });
  it("only renders Cancel when supplied by its owner", async () => {
    await render(); expect(host.querySelectorAll("button")).toHaveLength(1);
    const cancel = vi.fn();
    await render({ cancel: { label: t.cancel, onClick: cancel } });
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe(t.cancel); expect(button.className).toContain("min-h-11");
    await act(async () => button.click()); expect(cancel).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  });
});
