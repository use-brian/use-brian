// @vitest-environment jsdom
/**
 * [COMP:app-web/plan-slot-peek] The slot editor's TIME field.
 *
 * Regression test for a shipped bug: the field derived its `value` from the
 * committed minute, so every intermediate string a person types ("0", "09",
 * "09:") failed to parse, nothing committed, the render snapped back, and the
 * field was completely untypeable. It looked fine in a static render and in
 * every pure-function test of `parseSlotMinute`, because neither one types.
 *
 * So this drives real keystrokes through jsdom (`createRoot` + `act`, matching
 * the rest of app-web) rather than asserting on markup.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PlanSlotPeek, type PlanSlotDraft } from "../plan-slot-peek";
import type { PlanSlot } from "@/lib/feed-plan";

const dict = en as unknown as Dictionary;
let host: HTMLDivElement;
let root: Root;

function baseDraft(over: Partial<PlanSlotDraft> = {}): PlanSlotDraft {
  return {
    id: "slot-1",
    platform: "threads",
    scheduledFor: "2026-08-04",
    scheduledMinute: 540, // 09:00
    title: "Launch recap",
    brief: "",
    ...over,
  };
}

/** Mount the peek and keep the draft in a closure, as the real parent does. */
function persisted(over: Partial<PlanSlot> = {}): PlanSlot {
  return {
    id: "slot-1",
    assistantId: "a-1",
    platform: "threads",
    scheduledFor: "2026-08-04",
    scheduledMinute: 540,
    title: "Launch recap",
    brief: null,
    media: [],
    status: "planned",
    draftId: null,
    sessionId: null,
    createdBy: "u-1",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function mount(initial: PlanSlotDraft, slot: PlanSlot | null = null) {
  let draft = initial;
  const render = () =>
    act(() => {
      root.render(
        <I18nProvider locale="en" dict={dict}>
          <PlanSlotPeek
            draft={draft}
            slot={slot}
            canEdit
            busy={false}
            onChange={(next) => {
              draft = next;
              render();
            }}
            onSave={() => {}}
            onDelete={() => {}}
            onDraftThis={() => {}}
            onOpenDraft={() => {}}
            onToggleSkip={() => {}}
            onDiscuss={() => {}}
            onBack={() => {}}
          />
        </I18nProvider>,
      );
    });
  render();
  return { get draft() { return draft; } };
}

function timeInput(): HTMLInputElement {
  const el = [...host.querySelectorAll("input")].find(
    (i) => i.placeholder === en.feedPage.plan.timePlaceholder,
  );
  if (!el) throw new Error("time input not found");
  return el as HTMLInputElement;
}

/** Type one character at a time, the way a person does. */
function type(el: HTMLInputElement, text: string) {
  for (const ch of text) {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, el.value + ch);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function clear(el: HTMLInputElement) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("[COMP:app-web/plan-slot-peek] Time field", () => {
  it("shows the stored minute as a wall clock", () => {
    mount(baseDraft());
    expect(timeInput().value).toBe("09:00");
  });

  it("accepts a typed time character by character", () => {
    // The bug: intermediate strings never survived, so the field could not be
    // edited at all. Every keystroke below has to stick.
    const h = mount(baseDraft());
    const el = timeInput();
    clear(el);
    type(el, "14:30");
    expect(el.value).toBe("14:30");
    expect(h.draft.scheduledMinute).toBe(870);
  });

  it("keeps partial input visible without committing it", () => {
    const h = mount(baseDraft());
    const el = timeInput();
    clear(el);
    type(el, "14:");
    // Visible to the operator...
    expect(el.value).toBe("14:");
    // ...but not yet a minute, and it did NOT corrupt the stored value.
    expect(h.draft.scheduledMinute).toBeNull();
  });

  it("clears the time when the field is emptied", () => {
    const h = mount(baseDraft());
    clear(timeInput());
    expect(h.draft.scheduledMinute).toBeNull();
  });

  it("snaps back to the stored value when left unparseable", () => {
    const h = mount(baseDraft());
    const el = timeInput();
    clear(el);
    type(el, "9");
    expect(h.draft.scheduledMinute).toBeNull();
    act(() => {
      // React maps onBlur onto the bubbling `focusout`, not `blur`.
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    // Nothing meaningful was entered, so the field stops showing a stray "9".
    expect(timeInput().value).toBe("");
  });
});

function saveButton(): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === en.feedPage.plan.saveSlot,
  ) as HTMLButtonElement | undefined;
}

describe("[COMP:app-web/plan-slot-peek] Saving a time-only edit", () => {
  it("offers no Save while nothing has changed", () => {
    mount(baseDraft(), persisted());
    expect(saveButton()).toBeUndefined();
  });

  it("enables Save when ONLY the time changed", () => {
    // The bug: `dirty` compared title/brief/platform but not the minute, so a
    // time-only edit left Save disabled and the footer showed "Draft this"
    // instead -- the edit was unsaveable.
    mount(baseDraft(), persisted());
    const el = timeInput();
    clear(el);
    type(el, "14:30");
    const btn = saveButton();
    expect(btn).toBeDefined();
    expect(btn!.disabled).toBe(false);
  });

  it("enables Save when the time is cleared", () => {
    mount(baseDraft(), persisted());
    clear(timeInput());
    const btn = saveButton();
    expect(btn).toBeDefined();
    expect(btn!.disabled).toBe(false);
  });
});
