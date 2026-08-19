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
  type MentionAssistant,
} from "../mention-autocomplete";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const assistants = [
  { id: "blendit", name: "Blendit" },
  { id: "blendit-media", name: "Blendit Media" },
];

/**
 * Room human `@mentions` (docs/plans/room-human-mentions.md T-H4/T-H5/T-H9):
 * assistants first (D-H3's tie-break relies on roster order), a member with
 * a multi-word display name to exercise the space-mid-token case, and an
 * assistant/member pair that collides on a shorter name for the tie test.
 */
const mergedRoster: MentionAssistant[] = [
  { id: "blendit", name: "Blendit", mentionKind: "assistant" },
  { id: "blendit-media", name: "Blendit Media", mentionKind: "assistant" },
  { id: "jane-doe", name: "Jane Doe", mentionKind: "member" },
];

function Harness(props: { roster?: MentionAssistant[] }) {
  const roster = props.roster ?? assistants;
  const [value, setValue] = useState("");
  const mentions = useAssistantMentions({
    enabled: true,
    assistants: roster,
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
      {/* T-H9 — every resolved mention is a highlightRanges entry; a member's
       *  entry carries the extra `composer-mention-chip-member` class that
       *  `@use-brian/chat-ui`'s ChatComposer appends alongside the base chip
       *  class, so this DOM harness can assert on the SAME data the real
       *  composer paints from without re-implementing the mirror. */}
      <span data-testid="highlight-ranges">
        {mentions.highlightRanges
          .map((r) => `${r.start}-${r.end}:${r.className ?? "base"}`)
          .join(",")}
      </span>
      <button type="button" data-testid="outside">
        elsewhere
      </button>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(roster?: MentionAssistant[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <Harness roster={roster} />
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

/**
 * Room human `@mentions` (docs/plans/room-human-mentions.md T-H4/T-H5/T-H9)
 * — the merged assistant + member roster. What the send path does with the
 * resolved mentions (member-only = silent post, mixed = today's assistant
 * POSTs, an exact tie resolves to the assistant) is proven at the pure
 * `partitionRoomMentions` seam in `multi-assistant-response.test.ts`, since
 * that decision lives in `send()`/`resolveEditDispatch`, not in this popup.
 * This suite covers what only a DOM harness can: the popup offering both
 * kinds, a multi-word member name surviving a space mid-token, and the two
 * kinds painting distinguishably.
 */
describe("[COMP:app-web/mention-autocomplete] room human mentions (merged roster)", () => {
  it("offers both assistants and members from the merged roster", async () => {
    await mount(mergedRoster);
    await type("@");
    expect(options()).toHaveLength(3);
    const texts = options().map((option) => option.textContent ?? "");
    expect(texts.some((text) => text.includes("Blendit Media"))).toBe(true);
    expect(texts.some((text) => text.includes("Jane Doe"))).toBe(true);
  });

  it("keeps offering a member's multi-word name through the space mid-token", async () => {
    // Names can contain spaces (the same rule that already applies to
    // assistants) — typing the space in "@Jane " must not close the popup
    // or break the token.
    await mount(mergedRoster);
    await type("@Jane ");
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("Jane Doe");
  });

  it("inserts a member mention the same way as an assistant mention", async () => {
    await mount(mergedRoster);
    await type("@Jane");
    await press("Enter");
    expect(inputValue()).toBe("@Jane Doe ");
    expect(options()).toHaveLength(0);
  });

  it("paints an assistant mention with the base chip and a member mention with an extra class (T-H9)", async () => {
    // Both are real highlightRanges entries (the SAME painting pipeline —
    // @use-brian/chat-ui's ChatComposer always keeps the base
    // composer-mention-chip class and appends this one) — the two must be
    // distinguishable before send, because one costs a turn and the other
    // does not.
    await mount(mergedRoster);
    await type("@Blendit hello @Jane Doe");
    expect(
      container!.querySelector('[data-testid="highlight-ranges"]')!.textContent,
    ).toBe("0-8:base,15-24:composer-mention-chip-member");
  });

  it("an exact name tie between an assistant and a member offers the assistant's popup entry first (D-H3)", async () => {
    const tied: MentionAssistant[] = [
      { id: "a-jane", name: "Jane", mentionKind: "assistant" },
      { id: "m-jane", name: "Jane", mentionKind: "member" },
    ];
    await mount(tied);
    await type("@Jane");
    // Both are legitimate autocomplete offers (the popup is a convenience,
    // not the authority — the actual tie-break on a FULLY typed name is
    // resolveMentionSpans' stable sort, covered in
    // multi-assistant-response.test.ts). What this DOM harness can prove is
    // ordering: the assistant entry renders first, matching the roster order
    // `mentionTargets` builds it in (assistants first). The two rows are
    // otherwise identically named, so the aria-label — which encodes kind
    // ("Mention" vs "Notify") — is the only way to tell them apart here.
    expect(options()).toHaveLength(2);
    expect(options()[0].getAttribute("aria-label")).toBe("Mention Jane");
    expect(options()[1].getAttribute("aria-label")).toBe("Notify Jane");
  });
});
