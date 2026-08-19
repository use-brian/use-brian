// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-find] Find bar — the live chord-to-highlight contract.
 *
 * `find-in-page.test.ts` covers the matcher and the plugin's state machine in
 * isolation. This mounts the REAL `@tiptap/react` editor with the real bar on
 * top of it, because the parts that break in a browser are the ones neither
 * pure test can see: whether the window-level ⌘F listener is actually bound
 * and suppresses the native find bar, whether the decorations reach the
 * editor's DOM, and whether Enter / Escape do what the bar claims.
 */

import { describe, expect, it, afterEach, beforeAll, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useEditor, EditorContent } from "@tiptap/react";
import { browserDocExtensions } from "../doc-schema";
import { docFindExtension } from "../find-in-page";
import { DocFindBar } from "../find-bar";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // jsdom implements neither, and the bar calls both on a real page.
  Element.prototype.scrollIntoView = vi.fn();
  // A mac UA so the chord under test is ⌘F (the platform split is asserted
  // per-platform in find-in-page.test.ts).
  Object.defineProperty(window.navigator, "userAgent", {
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
    configurable: true,
  });
});

let activeRoot: Root | null = null;
let activeHost: HTMLElement | null = null;

afterEach(() => {
  act(() => activeRoot?.unmount());
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

const HTML =
  "<p>alpha beta</p><p>the alpha again</p>";

function Harness() {
  const editor = useEditor({
    immediatelyRender: true,
    content: HTML,
    extensions: [...browserDocExtensions(), docFindExtension()],
  });
  return createElement(
    "div",
    null,
    createElement(DocFindBar, { editor }),
    createElement(EditorContent, { editor }),
  );
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  activeRoot = root;
  activeHost = host;
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        // Children ride in props (the toggle-collapse test's idiom): the
        // third-arg overload trips TS's required-`children` check here.
        { dict: en, locale: "en", children: createElement(Harness) } as never,
      ),
    );
  });
  return host;
}

/** Press ⌘F on the window, the way the user does from anywhere on the page. */
async function pressFindChord(): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", {
    key: "f",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    window.dispatchEvent(e);
  });
  return e;
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string, shiftKey = false) {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });
}

function bar(host: HTMLElement) {
  return host.querySelector<HTMLElement>('[role="search"]');
}

function input(host: HTMLElement) {
  return host.querySelector<HTMLInputElement>('[role="search"] input')!;
}

describe("[COMP:app-web/doc-find] Find bar", () => {
  it("renders nothing until the chord, and claims the chord when it fires", async () => {
    const host = await mount();
    expect(bar(host)).toBeNull();

    const event = await pressFindChord();
    expect(bar(host)).not.toBeNull();
    // The native find bar must not also open.
    expect(event.defaultPrevented).toBe(true);
  });

  it("highlights every hit in the editor DOM and marks exactly one active", async () => {
    const host = await mount();
    await pressFindChord();
    await type(input(host), "alpha");

    const hits = host.querySelectorAll(".doc-find-match");
    expect(hits).toHaveLength(2);
    expect(host.querySelectorAll(".doc-find-match-active")).toHaveLength(1);
    // The active one is the first hit, and the highlight covers the word.
    expect(hits[0].classList.contains("doc-find-match-active")).toBe(true);
    expect(hits[0].textContent).toBe("alpha");
  });

  it("counts the hits", async () => {
    const host = await mount();
    await pressFindChord();
    await type(input(host), "alpha");
    expect(bar(host)!.textContent).toContain("1 of 2");
  });

  it("steps forward on Enter and back on Shift+Enter, wrapping", async () => {
    const host = await mount();
    await pressFindChord();
    await type(input(host), "alpha");

    await press(input(host), "Enter");
    expect(bar(host)!.textContent).toContain("2 of 2");
    // Past the end wraps back to the first hit.
    await press(input(host), "Enter");
    expect(bar(host)!.textContent).toContain("1 of 2");
    await press(input(host), "Enter", true);
    expect(bar(host)!.textContent).toContain("2 of 2");
  });

  it("says so when nothing matches, and paints no highlight", async () => {
    const host = await mount();
    await pressFindChord();
    await type(input(host), "nothing here");

    expect(bar(host)!.textContent).toContain(en.docPage.find.noResults);
    expect(host.querySelectorAll(".doc-find-match")).toHaveLength(0);
  });

  it("frames the BAR on focus, not the bare input (composite-field convention)", async () => {
    // globals.css paints a `:focus-visible` halo on every focusable element,
    // and `outline-none` alone does not stop it (it is a box-shadow). Left
    // alone, the input inside the pill grew its own sharp-cornered ring. The
    // pill owns the ring while the input has focus; the nav/close buttons are
    // NOT suppressed, so keyboard focus on them stays visible.
    const host = await mount();
    await pressFindChord();
    const pill = bar(host)!;
    expect(pill.className).toContain("has-[input:focus-visible]:ring-2");
    expect(input(host).className).toContain("focus-visible:shadow-none");
    for (const b of pill.querySelectorAll("button")) {
      expect(b.className).not.toContain("shadow-none");
    }
    expect(pill.className).not.toContain("[&_:focus-visible]:shadow-none");
  });

  it("closes on Escape and clears every highlight", async () => {
    const host = await mount();
    await pressFindChord();
    await type(input(host), "alpha");
    expect(host.querySelectorAll(".doc-find-match")).toHaveLength(2);

    await press(input(host), "Escape");
    expect(bar(host)).toBeNull();
    expect(host.querySelectorAll(".doc-find-match")).toHaveLength(0);
  });
});
