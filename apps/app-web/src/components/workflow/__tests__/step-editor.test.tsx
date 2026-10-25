// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RawJsonFields } from "../step-editor";
import { en } from "@/lib/i18n/dictionaries/en";
import type { WorkflowStep } from "@/lib/api/workflow";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
const tool: WorkflowStep = { id: "tool-1", type: "tool_call", toolName: "listTasks", arguments: {} };
function mount(step: WorkflowStep = tool, disabled = false) {
  const changed = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(step);
    return <RawJsonFields step={draft} disabled={disabled} t={en} onChange={(next) => { changed(next); setDraft(next); }} />;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
  return changed;
}
function input(text: string) {
  const textarea = container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return textarea;
}

describe("[COMP:app-web/workflow] raw step draft safety", () => {
  it.each([
    ["tool name in type", { ...tool, type: "searchKnowledge" }],
    ["missing type", { id: tool.id, toolName: "searchKnowledge" }],
    ["missing id", { type: "tool_call", toolName: "searchKnowledge" }],
    ["changed id", { ...tool, id: "another-step" }],
    ["type switch without required fields", { ...tool, type: "assistant_call" }],
    ["non-string tool name", { ...tool, toolName: {} }],
    ["non-string title", { ...tool, description: {} }],
    ["invalid edge", { ...tool, nextStepId: [42] }],
    ["invalid arguments", { ...tool, arguments: null }],
    ["null", null],
    ["array", []],
    ["string", "searchKnowledge"],
  ])("keeps %s local and recovers after correction", (_label, malformed) => {
    const changed = mount();
    const text = JSON.stringify(malformed);
    const textarea = input(text);
    expect(changed).not.toHaveBeenCalled();
    expect(textarea.value).toBe(text);
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain(en.workflowPage.builder.stepJsonInvalid);
    const corrected = { ...tool, toolName: "searchKnowledge", arguments: { query: "{{input.query}}" } };
    input(JSON.stringify(corrected));
    expect(changed).toHaveBeenCalledExactlyOnceWith(corrected);
    expect(textarea.getAttribute("aria-invalid")).toBe("false");
    expect(container.textContent).not.toContain(en.workflowPage.builder.stepJsonInvalid);
  });

  it("keeps incomplete JSON out of the draft", () => {
    const changed = mount();
    input('{"id":');
    expect(changed).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.workflowPage.builder.stepJsonInvalid);
  });

  it("rejects a wait missing its nested duration without breaking valid edits", () => {
    const wait: WorkflowStep = { id: "wait-1", type: "wait", until: { duration: { minutes: 5 } } };
    const changed = mount(wait);
    input(JSON.stringify({ ...wait, until: {} }));
    expect(changed).not.toHaveBeenCalled();
    const next = { ...wait, until: { duration: { hours: 1 } } };
    input(JSON.stringify(next));
    expect(changed).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("preserves valid parallel tool edges and approval settings", () => {
    const changed = mount();
    const next = { ...tool, nextStepId: ["a", "b"], approval: { required: true } };
    input(JSON.stringify(next));
    expect(changed).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("validates branch edges while preserving arbitrary JSONLogic", () => {
    const branch: WorkflowStep = { id: "branch-1", type: "branch", condition: true, nextStepIdIfTrue: null, nextStepIdIfFalse: null };
    const changed = mount(branch);
    input(JSON.stringify({ ...branch, nextStepIdIfTrue: {} }));
    expect(changed).not.toHaveBeenCalled();
    const next = { ...branch, condition: { "==": [{ var: "input.enabled" }, true] }, nextStepIdIfTrue: "tool-1" };
    input(JSON.stringify(next));
    expect(changed).toHaveBeenCalledExactlyOnceWith(next);
  });
});


describe("[COMP:app-web/workflow] approval notification channel", () => {
  const b = en.workflowPage.builder;
  async function choose(label: string) {
    await act(async () => container.querySelector<HTMLButtonElement>("[role=combobox]")!.click());
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")]
      .find((node) => node.textContent === label)!;
    expect(option).toBeTruthy();
    await act(async () => { option.focus(); });
    await act(async () => option.click());
  }

  it("defaults to web without mutating the draft and offers only supported channels", async () => {
    const changed = mount();
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(b.approvalChannelWeb);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>("[role=combobox]")!.click());
    expect([...document.querySelectorAll("[role=option]")].map((node) => node.textContent))
      .toEqual([b.approvalChannelWeb, b.approvalChannelRecent, b.deliverChannelTelegram]);
  });

  it.each([true, false, undefined])("preserves required=%s and expiry while syncing Advanced JSON", async (required) => {
    const step: WorkflowStep = { ...tool, approval: { required, expiresAfterHours: 12 } };
    const changed = mount(step);
    await choose(b.approvalChannelRecent);
    const next = { ...step, approval: { ...step.approval, deliveryChannel: "recent" } };
    expect(changed).toHaveBeenLastCalledWith(next);
    expect(JSON.parse(container.querySelector("textarea")!.value)).toEqual(JSON.parse(JSON.stringify(next)));
    await choose(b.deliverChannelTelegram);
    expect(changed).toHaveBeenLastCalledWith({ ...step, approval: { ...step.approval, deliveryChannel: "telegram" } });
    await choose(b.approvalChannelWeb);
    expect(changed).toHaveBeenLastCalledWith({ ...step, approval: { ...step.approval, deliveryChannel: "web" } });
  });

  it.each(["slack", "whatsapp", "msteams", "feishu"] as const)("preserves existing %s configuration", async (deliveryChannel) => {
    const step: WorkflowStep = { ...tool, approval: { deliveryChannel, required: true } };
    const changed = mount(step);
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(deliveryChannel);
    expect(changed).not.toHaveBeenCalled();
    input(JSON.stringify({ ...step, description: "Renamed" }));
    expect(changed).toHaveBeenLastCalledWith({ ...step, description: "Renamed" });
    await choose(b.approvalChannelRecent);
    expect(changed).toHaveBeenLastCalledWith({ ...step, description: "Renamed", approval: { required: true, deliveryChannel: "recent" } });
  });

  it("reflects recent selected through Advanced JSON", () => {
    mount();
    input(JSON.stringify({ ...tool, approval: { deliveryChannel: "recent" } }));
    expect(container.querySelector("[role=combobox]")?.textContent).toContain(b.approvalChannelRecent);
  });

  it("disables channel changes when the editor is disabled", () => {
    mount(tool, true);
    expect(container.querySelector<HTMLButtonElement>("[role=combobox]")!.disabled).toBe(true);
  });

  it("protects an invalid JSON draft from selector edits", () => {
    mount();
    input('{');
    expect(container.querySelector<HTMLButtonElement>("[role=combobox]")!.disabled).toBe(true);
  });

  it("does not show approval channels on wait steps", () => {
    mount({ id: "wait", type: "wait", until: { duration: { minutes: 1 } } });
    expect(container.querySelector("[role=combobox]")).toBeNull();
  });
});
