// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowTrigger } from "@/lib/api/workflow";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { TriggerEditor } from "../trigger-editor";

// Isolate the picker from panel API requests and configuration controls.
vi.mock("../manual-trigger-panel", () => ({
  ManualTriggerPanel: () => <div data-panel="manual" />,
}));
vi.mock("../schedule-trigger-fields", () => ({
  ScheduleTriggerFields: ({ trigger }: { trigger: WorkflowTrigger }) => (
    <div data-panel="schedule">{JSON.stringify(trigger)}</div>
  ),
}));
vi.mock("../webhook-trigger-fields", () => ({
  WebhookTriggerFields: () => <div data-panel="webhook" />,
}));
vi.mock("../event-trigger-fields", () => ({
  EventTriggerFields: () => <div data-panel="event" />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const triggers: WorkflowTrigger[] = [
  { kind: "manual" },
  { kind: "schedule", schedule: { type: "weekly", days: ["friday"], time: "14:30" }, timezone: "Asia/Tokyo" },
  { kind: "webhook" },
  { kind: "event", event: { sources: [] } },
];
const labels = [
  en.workflowPage.builder.triggerManual,
  en.workflowPage.builder.triggerSchedule,
  en.workflowPage.builder.triggerWebhook,
  en.workflowPage.builder.triggerEvent,
];

function mount(trigger: WorkflowTrigger, disabled = false) {
  const onChange = vi.fn();
  function Harness() {
    const [value, setValue] = useState(trigger);
    return (
      <I18nProvider locale="en" dict={en}>
        <TriggerEditor
          workflowId="workflow-1"
          workspaceId="workspace-1"
          trigger={value}
          webhookSlug={null}
          webhookSecret={null}
          onRotateWebhook={vi.fn()}
          onChange={(next) => { onChange(next); setValue(next); }}
          disabled={disabled}
        />
      </I18nProvider>
    );
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
  return onChange;
}

function cards() {
  return Array.from(host!.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
}

function expectSelection(kind: WorkflowTrigger["kind"]) {
  expect(host!.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"))
    .toBe(en.workflowPage.builder.triggerHeading);
  expect(cards()).toHaveLength(4);
  cards().forEach((card, index) => {
    const selected = triggers[index].kind === kind;
    expect(card.getAttribute("aria-checked")).toBe(String(selected));
    expect(card.textContent).toContain(labels[index]);
    expect(card.type).toBe("button");
    expect(card.className).not.toMatch(/(?:border|bg|ring|text)-primary/);
    const icon = card.querySelector("span")!;
    expect(icon.className).not.toMatch(/(?:bg|text)-primary/);
    if (selected) {
      expect(card.classList.contains("border-interaction/60")).toBe(true);
      expect(card.classList.contains("bg-interaction/5")).toBe(true);
      expect(card.classList.contains("ring-interaction/20")).toBe(true);
      expect(icon.classList.contains("bg-interaction/10")).toBe(true);
      expect(icon.classList.contains("text-foreground")).toBe(true);
    } else {
      expect(card.classList.contains("hover:border-interaction/40")).toBe(true);
      expect(card.classList.contains("hover:bg-muted/40")).toBe(true);
      expect(card.classList.contains("bg-interaction/5")).toBe(false);
      expect(icon.classList.contains("text-muted-foreground")).toBe(true);
    }
  });
  expect(host!.querySelectorAll("[data-panel]")).toHaveLength(1);
  expect(host!.querySelector("[data-panel]")?.getAttribute("data-panel")).toBe(kind);
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("[COMP:app-web/workflow] TriggerEditor selection", () => {
  it.each(triggers)("uses neutral selection for $kind and keeps the current union unchanged", (trigger) => {
    const onChange = mount(trigger);
    expectSelection(trigger.kind);
    const selected = cards().find((card) => card.getAttribute("aria-checked") === "true")!;
    expect(selected.tabIndex).toBe(0);
    act(() => selected.focus());
    expect(document.activeElement).toBe(selected);
    act(() => selected.click());
    expect(onChange).not.toHaveBeenCalled();
    if (trigger.kind === "schedule") {
      expect(host!.querySelector('[data-panel="schedule"]')?.textContent).toBe(JSON.stringify(trigger));
    }
  });

  it("moves selection and mounts each panel with the existing default trigger shapes", () => {
    const onChange = mount(triggers[0]);
    const defaults: WorkflowTrigger[] = [
      { kind: "schedule", schedule: { type: "daily", time: "09:00" } },
      { kind: "webhook" },
      { kind: "event", event: { sources: [] } },
      { kind: "manual" },
    ];
    for (const next of defaults) {
      const index = triggers.findIndex((trigger) => trigger.kind === next.kind);
      act(() => cards()[index].click());
      expect(onChange).toHaveBeenLastCalledWith(next);
      expectSelection(next.kind);
    }
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("keeps disabled choices unavailable without changing selection", () => {
    const onChange = mount(triggers[1], true);
    for (const card of cards()) {
      expect(card.disabled).toBe(true);
      act(() => card.click());
    }
    expect(onChange).not.toHaveBeenCalled();
    expectSelection("schedule");
  });
});
