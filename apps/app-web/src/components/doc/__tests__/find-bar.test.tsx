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
import { act, createElement, useEffect, type ReactNode } from "react";
import type { Editor } from "@tiptap/core";
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
  window.history.replaceState(null, "", "/");
});

const HTML =
  "<p>alpha beta</p><p>the alpha again</p>";

const scope = { ownerId: "page-owner", workspaceId: "workspace-a", pageId: "page-a" };
type Scope = typeof scope;
type HarnessProps = { requestScope?: Scope; editable?: boolean; onEditor?: (editor: Editor | null) => void };

function Harness({ requestScope, editable = true, onEditor }: HarnessProps) {
  const editor = useEditor({
    immediatelyRender: true,
    content: HTML,
    editable,
    extensions: [...browserDocExtensions(), docFindExtension()],
  });
  useEffect(() => { onEditor?.(editor); }, [editor, onEditor]);
  return createElement(
    "div",
    null,
    createElement(DocFindBar, { editor, requestScope }),
    createElement(EditorContent, { editor }),
  );
}

async function mount(children: ReactNode = createElement(Harness)): Promise<HTMLElement> {
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
        { dict: en, locale: "en", children } as never,
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

async function requestFind(detail: unknown = scope) {
  await act(async () => window.dispatchEvent(new CustomEvent("doc:find-open", { detail })));
}

function activatePage(page = scope) {
  window.history.replaceState(null, "", `/w/${page.workspaceId}/p/${page.pageId}`);
}

describe("[COMP:app-web/doc-find] Find bar", () => {
  it("opens the scoped touch request with the existing local match and close behavior", async () => {
    activatePage();
    const host = await mount(createElement(Harness, { requestScope: scope }));
    await requestFind();
    expect(bar(host)).not.toBeNull();
    await type(input(host), "alpha");
    expect(bar(host)!.textContent).toContain("1 of 2");
    const next = bar(host)!.querySelector<HTMLButtonElement>(`[aria-label="${en.docPage.find.next}"]`)!;
    await act(async () => next.click());
    expect(bar(host)!.textContent).toContain("2 of 2");
    await act(async () => bar(host)!.querySelector<HTMLButtonElement>(`[aria-label="${en.docPage.find.close}"]`)!.click());
    expect(bar(host)).toBeNull();
    expect(host.querySelectorAll(".doc-find-match")).toHaveLength(0);
  });

  it("addresses only its editor owner when the same page has two mounted editors", async () => {
    activatePage();
    const host = await mount(createElement("div", null,
      createElement(Harness, { requestScope: scope }),
      createElement(Harness, { requestScope: { ...scope, ownerId: "other-owner" } }),
      createElement(Harness),
    ));
    await requestFind();
    expect(host.querySelectorAll('[role="search"]')).toHaveLength(1);
    await type(input(host), "alpha");
    expect(host.querySelectorAll(".doc-find-match")).toHaveLength(2);
  });

  it("rejects malformed and mismatched requests and ignores its request on a stale route", async () => {
    activatePage();
    const host = await mount(createElement(Harness, { requestScope: scope }));
    for (const detail of [null, {}, { ...scope, ownerId: "other" }, { ...scope, pageId: "other" }, { ...scope, workspaceId: "other" }]) {
      await requestFind(detail);
      expect(bar(host)).toBeNull();
    }
    activatePage({ ...scope, pageId: "other" });
    await requestFind();
    expect(bar(host)).toBeNull();
    activatePage();
    await requestFind();
    expect(bar(host)).not.toBeNull();
  });

  it("searches a read-only selection without a document mutation", async () => {
    activatePage();
    let editor: Editor | null = null;
    const host = await mount(createElement(Harness, { requestScope: scope, editable: false, onEditor: value => { editor = value; } }));
    const live = editor as unknown as Editor;
    const before = live.getJSON();
    const changes: boolean[] = [];
    live.on("transaction", ({ transaction }) => { changes.push(transaction.docChanged); });
    await act(async () => { live.commands.setTextSelection({ from: 1, to: 6 }); });
    await requestFind();
    expect(bar(host)).not.toBeNull();
    expect(input(host).value).toBe("alpha");
    expect(bar(host)!.textContent).toContain("1 of 2");
    expect(live.getJSON()).toEqual(before);
    expect(changes.every(changed => !changed)).toBe(true);
  });

  it("closes when its page identity changes before the editor rebuilds", async () => {
    activatePage();
    const host = await mount(createElement(Harness, { requestScope: scope }));
    await requestFind();
    expect(bar(host)).not.toBeNull();
    await type(input(host), "alpha");
    const next = { ...scope, pageId: "page-b" };
    activatePage(next);
    await act(async () => activeRoot!.render(createElement(I18nProvider, { dict: en, locale: "en", children: createElement(Harness, { requestScope: next }) } as never)));
    expect(bar(host)).toBeNull();
    expect(host.querySelectorAll(".doc-find-match")).toHaveLength(0);
    await requestFind();
    expect(bar(host)).toBeNull();
    await requestFind(next);
    expect(input(host).value).toBe("");
  });

  it("removes the request listener when its editor unmounts", async () => {
    activatePage();
    const host = await mount(createElement(Harness, { requestScope: scope }));
    await requestFind();
    expect(bar(host)).not.toBeNull();
    await act(async () => activeRoot!.render(null));
    await requestFind();
    expect(bar(host)).toBeNull();
  });

  it("ignores its matching request while its kept-alive editor is hidden", async () => {
    activatePage();
    const host = await mount(createElement("div", { hidden: true }, createElement(Harness, { requestScope: scope })));
    await requestFind();
    expect(bar(host)).toBeNull();
    host.firstElementChild!.removeAttribute("hidden");
    await requestFind();
    expect(bar(host)).not.toBeNull();
  });

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
    // The input belongs to a composite pill, so the pill's existing border is
    // the only frame that changes on focus. The nav/close buttons are NOT
    // suppressed, so keyboard focus on them stays visible.
    const host = await mount();
    await pressFindChord();
    const pill = bar(host)!;
    expect(pill.className).toContain("has-[input:focus-visible]:border-ring");
    expect(pill.className).not.toMatch(/has-\[input:focus-visible\]:ring-/);
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
