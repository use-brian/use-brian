// @vitest-environment jsdom
/**
 * [COMP:app-web/mention-autocomplete] Dismissal and keyboard confirmation.
 *
 * The pure open/close rules live in `multi-assistant-response`; what needs a
 * DOM is the part the user complained about — the popup felt stuck, because
 * nothing but a completed pick could close it. Escape and a pointer landing
 * outside the field must both collapse it, and neither may reopen it on the
 * next keystroke of the same `@`.
 *
 * The keyboard half is here for the same reason: Tab must confirm what is
 * highlighted, so what the user sees selected is what lands in the text.
 */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  MentionAutocompleteList,
  useAssistantMentions,
} from "../mention-autocomplete";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const assistants = [
  { id: "blendit", name: "Blendit" },
  { id: "blendit-media", name: "Blendit Media" },
];

function Harness() {
  const [value, setValue] = useState("");
  const mentions = useAssistantMentions({
    enabled: true,
    assistants,
    value,
    onChange: setValue,
  });
  return (
    <div>
      <div ref={mentions.containerRef} data-testid="field">
        <MentionAutocompleteList mentions={mentions} />
        <textarea
          data-testid="input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={mentions.handleKeyDown}
        />
      </div>
      <button type="button" data-testid="outside">
        elsewhere
      </button>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <Harness />
      </I18nProvider>,
    );
  });
  return container;
}

function options(): HTMLElement[] {
  return Array.from(container?.querySelectorAll('[role="option"]') ?? []);
}

async function type(text: string) {
  const input = container!.querySelector<HTMLTextAreaElement>(
    '[data-testid="input"]',
  )!;
  await act(async () => {
    // React tracks the DOM value on the node; go through its setter so the
    // synthetic change event is not swallowed as a no-op.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, shiftKey = false) {
  const input = container!.querySelector<HTMLTextAreaElement>(
    '[data-testid="input"]',
  )!;
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function inputValue(): string {
  return container!.querySelector<HTMLTextAreaElement>(
    '[data-testid="input"]',
  )!.value;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/mention-autocomplete] dismissing the popup", () => {
  it("opens on `@` and lists the matching roster", async () => {
    await mount();
    await type("@Blend");
    expect(options()).toHaveLength(2);
  });

  it("closes on Escape and stays closed while the same `@` is typed", async () => {
    await mount();
    await type("@Blend");
    await press("Escape");
    expect(options()).toHaveLength(0);
    await type("@Blendi");
    expect(options()).toHaveLength(0);
  });

  it("reopens for a NEW mention after an Escape", async () => {
    await mount();
    await type("@Blend");
    await press("Escape");
    await type("@Blendit Media and @Blend");
    expect(options()).toHaveLength(2);
  });

  it("closes on a pointer outside the field", async () => {
    await mount();
    await type("@Blend");
    expect(options()).toHaveLength(2);
    const outside = container!.querySelector<HTMLElement>(
      '[data-testid="outside"]',
    )!;
    await act(async () => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(options()).toHaveLength(0);
  });

  it("stays open for a pointer inside the field", async () => {
    await mount();
    await type("@Blend");
    const field = container!.querySelector<HTMLElement>('[data-testid="field"]')!;
    await act(async () => {
      field.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(options()).toHaveLength(2);
  });

  it("does not re-offer the longer name after a pick", async () => {
    // The reported bug: choosing @Blendit left @Blendit Media suggested, and
    // the next keystroke would have completed the wrong assistant.
    await mount();
    await type("@Blend");
    await act(async () => {
      options()[0].dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    const input = container!.querySelector<HTMLTextAreaElement>(
      '[data-testid="input"]',
    )!;
    expect(input.value).toBe("@Blendit ");
    expect(options()).toHaveLength(0);
    await type("@Blendit reconcile the orders");
    expect(options()).toHaveLength(0);
  });
});

describe("[COMP:app-web/mention-autocomplete] confirming with the keyboard", () => {
  it("takes the highlighted option on Tab", async () => {
    await mount();
    await type("@Blend");
    await press("Tab");
    expect(inputValue()).toBe("@Blendit ");
    expect(options()).toHaveLength(0);
  });

  it("takes the highlighted option on Enter", async () => {
    await mount();
    await type("@Blend");
    await press("Enter");
    expect(inputValue()).toBe("@Blendit ");
  });

  it("takes what the arrows left highlighted, not the one after it", async () => {
    // The reported bug: Tab advanced the selection, so the option under the
    // highlight was never the one Tab landed on.
    await mount();
    await type("@Blend");
    await press("ArrowDown");
    await press("Tab");
    expect(inputValue()).toBe("@Blendit Media ");
  });

  it("confirms on Shift+Tab too, rather than walking focus out", async () => {
    await mount();
    await type("@Blend");
    await press("Tab", true);
    expect(inputValue()).toBe("@Blendit ");
  });

  it("leaves Shift+Enter to the composer as a newline", async () => {
    await mount();
    await type("@Blend");
    await press("Enter", true);
    expect(inputValue()).toBe("@Blend");
    expect(options()).toHaveLength(2);
  });
});
