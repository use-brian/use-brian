// @vitest-environment jsdom
/**
 * [COMP:app-web/block-action-menu] Block menu — capability gating.
 *
 * The SAME menu serves the full doc surface and the skill body editor's
 * md-restricted schema, so what it offers must derive from the mounted
 * editor's capabilities, not the host: Turn-into lists only
 * schema-representable kinds, Color needs the `color`/`bgColor` DocAttrs,
 * Copy-link needs the workspace+page context. Both hosts are exercised with
 * REAL editors (the pure gates are covered in block-actions.test.ts; this
 * pins the rendered rows).
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Editor, type AnyExtension } from "@tiptap/core";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";
import { skillBodySchemaExtensions } from "@/lib/skill-markdown";
import { browserDocExtensions } from "../doc-schema";
import { BlockActionMenu } from "../block-action-menu";
import type { BlockTarget } from "../block-actions";

const mocks = vi.hoisted(() => ({ bestInternalShareLink: vi.fn() }));
vi.mock("@/lib/api/internal-links", () => ({
  bestInternalShareLink: mocks.bestInternalShareLink,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
const ba = en.docPage.blockActions;
const slashItems = en.docPage.slashMenu.items;

let root: Root | null = null;
let host: HTMLElement | null = null;
let editor: Editor | null = null;
let editorEl: HTMLElement | null = null;
let anchor: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  editor?.destroy();
  editor = null;
  editorEl?.remove();
  editorEl = null;
  host?.remove();
  host = null;
  anchor?.remove();
  anchor = null;
  mocks.bestInternalShareLink.mockReset();
});

function mountMenu(opts: { extensions: AnyExtension[]; pageContext?: boolean }) {
  editorEl = document.createElement("div");
  document.body.appendChild(editorEl);
  editor = new Editor({
    element: editorEl,
    extensions: opts.extensions,
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hi" }] },
      ],
    },
  });
  const target: BlockTarget = { node: editor.state.doc.child(0), pos: 0 };
  anchor = document.createElement("div");
  document.body.appendChild(anchor);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        <BlockActionMenu
          editor={editor!}
          getTarget={() => target}
          anchorEl={anchor}
          onClose={() => {}}
          {...(opts.pageContext ? { workspaceId: "w1", pageId: "p1" } : {})}
        />
      </I18nProvider>,
    );
  });
}

/** The portalled menu root (the component portals to document.body). */
function menuEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-popover="block-actions"]');
  expect(el).not.toBeNull();
  return el!;
}

function rowLabels(): string[] {
  return Array.from(
    menuEl().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).map((b) => b.textContent ?? "");
}

/** The portalled hover panel (Turn into / Color). Not inside the menu scroller. */
function flyoutEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-submenu="flyout"]');
  expect(el).not.toBeNull();
  return el!;
}

function radioLabels(root: ParentNode = menuEl()): string[] {
  return Array.from(root.querySelectorAll('[role="menuitemradio"]')).map(
    (b) => b.textContent ?? "",
  );
}

/** Open a hover submenu (React derives mouseenter from a bubbling mouseover). */
function openSubmenu(label: string) {
  const row = Array.from(
    menuEl().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ).find((b) => (b.textContent ?? "").includes(label));
  expect(row).not.toBeUndefined();
  act(() => {
    row!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
}

describe("[COMP:app-web/block-action-menu] capability gating", () => {
  it("doc host: full menu — Turn-into catalogue, Color, Copy link", () => {
    mountMenu({ extensions: browserDocExtensions(), pageContext: true });
    const labels = rowLabels();
    expect(labels.some((l) => l.includes(ba.turnInto))).toBe(true);
    expect(labels.some((l) => l.includes(ba.color))).toBe(true);
    expect(labels.some((l) => l.includes(ba.copyLink))).toBe(true);
    expect(labels.some((l) => l.includes(ba.duplicate))).toBe(true);
    expect(labels.some((l) => l.includes(ba.delete))).toBe(true);

    openSubmenu(ba.turnInto);
    const kinds = radioLabels(flyoutEl());
    expect(kinds).toHaveLength(12);
    expect(kinds.some((l) => l.includes(slashItems.heading_4))).toBe(true);
    expect(kinds.some((l) => l.includes(slashItems.to_do))).toBe(true);
  });

  it("skill host (md schema, no page context): Turn-into filtered, no Color, no Copy link", () => {
    mountMenu({ extensions: [...skillBodySchemaExtensions] });
    const labels = rowLabels();
    expect(labels.some((l) => l.includes(ba.turnInto))).toBe(true);
    expect(labels.some((l) => l.includes(ba.color))).toBe(false);
    expect(labels.some((l) => l.includes(ba.copyLink))).toBe(false);
    // Comment never shows without an onComment handler.
    expect(labels.some((l) => l.includes(ba.comment))).toBe(false);
    expect(labels.some((l) => l.includes(ba.duplicate))).toBe(true);
    expect(labels.some((l) => l.includes(ba.delete))).toBe(true);

    openSubmenu(ba.turnInto);
    const kinds = radioLabels(flyoutEl());
    // paragraph, h1-3, bulleted, numbered, quote, code — the md set.
    expect(kinds).toHaveLength(8);
    expect(kinds.some((l) => l.includes(slashItems.heading_4))).toBe(false);
    expect(kinds.some((l) => l.includes(slashItems.to_do))).toBe(false);
    expect(kinds.some((l) => l.includes(slashItems.callout))).toBe(false);
    expect(kinds.some((l) => l.includes(slashItems.toggle))).toBe(false);
  });

  it("copies the capability-selected block link", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.bestInternalShareLink.mockResolvedValue({
      url: "https://brain.example/s/product/roadmap#b-block-1",
      capabilities: { internalLinkAliasesVersion: 1 },
    });
    mountMenu({ extensions: browserDocExtensions(), pageContext: true });
    const copy = Array.from(menuEl().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((button) => button.textContent?.includes(ba.copyLink));
    expect(copy).not.toBeUndefined();

    await act(async () => { copy!.click(); });

    expect(mocks.bestInternalShareLink).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "w1",
      pageId: "p1",
      blockId: expect.any(String),
    }));
    expect(writeText).toHaveBeenCalledWith("https://brain.example/s/product/roadmap#b-block-1");
  });
});

/**
 * Touch mode (responsive contract M2 / M5). A hover fly-out beside a 240px
 * menu has nowhere to go on a 390px phone, and a finger never hovers — so on
 * a coarse pointer a submenu row toggles on TAP and its list renders as a
 * second level INSIDE the menu. Pointer class comes from `matchMedia`, which
 * jsdom lacks, so the test installs one.
 */
describe("[COMP:app-web/block-action-menu] touch mode", () => {
  const originalMatchMedia = (window as { matchMedia?: unknown }).matchMedia;
  afterEach(() => {
    (window as { matchMedia?: unknown }).matchMedia = originalMatchMedia;
  });

  function installCoarseMatchMedia() {
    (window as { matchMedia?: unknown }).matchMedia = (query: string) => ({
      matches: query.includes("hover: none"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
  }

  it("opens Turn into inline on tap and never as a fly-out", () => {
    installCoarseMatchMedia();
    mountMenu({ extensions: browserDocExtensions(), pageContext: true });
    expect(menuEl().getAttribute("data-coarse")).toBe("true");
    // Every row is a 44px target on touch (M3).
    expect(menuEl().className).toContain("[&_[role=menuitem]]:min-h-11");

    const row = Array.from(
      menuEl().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((b) => (b.textContent ?? "").includes(ba.turnInto));
    expect(row).not.toBeUndefined();
    // A hover-derived mouseover must NOT open it on touch (a tap fires one
    // first, which would pre-empt the toggle).
    act(() => {
      row!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(menuEl().querySelector('[data-submenu]')).toBeNull();

    act(() => {
      row!.click();
    });
    const sub = menuEl().querySelector<HTMLElement>('[data-submenu]');
    expect(sub).not.toBeNull();
    expect(sub!.getAttribute("data-submenu")).toBe("inline");
    expect(sub!.className).not.toContain("left-full");
    expect(row!.getAttribute("aria-expanded")).toBe("true");
    expect(sub!.querySelectorAll('[role="menuitemradio"]').length).toBeGreaterThan(0);

    // Second tap folds it back.
    act(() => {
      row!.click();
    });
    expect(menuEl().querySelector('[data-submenu]')).toBeNull();
  });

  it("keeps the hover panel beside the menu, outside its scroll box", () => {
    mountMenu({ extensions: browserDocExtensions(), pageContext: true });
    expect(menuEl().getAttribute("data-coarse")).toBeNull();
    openSubmenu(ba.turnInto);
    const sub = flyoutEl();
    expect(menuEl().contains(sub)).toBe(false);
    expect(sub.getAttribute("data-popover")).toBe("block-actions-flyout");
    expect(sub.className).not.toContain("left-full");
    expect(sub.className).toContain("overflow-y-auto");
    expect(radioLabels(sub).length).toBeGreaterThan(0);
  });
});
