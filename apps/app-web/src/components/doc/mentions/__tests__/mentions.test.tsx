/**
 * [COMP:app-web/person-mention][COMP:app-web/page-mention][COMP:app-web/mention-popup]
 * Phase 4 — `@`-mention extensions + shared popup.
 *
 * app-web's Vitest runner is node-only (no jsdom — see
 * `apps/app-web/vitest.config.ts`), so this suite covers:
 *
 *   - the shared popup's SSR markup shape (tabs, rows, empty state),
 *   - the pure keyboard helpers (`nextSelectionIndex`, `nextTab`),
 *   - the Tiptap extension factories' surface (node name, returned
 *     extension object), and
 *   - each Node's `renderHTML` / `renderText` contract that the wire
 *     format depends on.
 *
 * Live editor flows — `@` opening the popup, click-outside dismiss,
 * actual Suggestion-plugin command dispatch — need a real DOM and are
 * left to a future jsdom-equipped suite. The contracts those pieces
 * honour are captured in unit form here.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MentionPopup,
  nextSelectionIndex,
  nextTab,
  type PageMentionItem,
  type PersonMentionItem,
} from "../mention-popup";
import {
  PersonMentionNode,
  createPersonMentionExtension,
} from "../person-mention";
import {
  PageMentionNode,
  createPageMentionExtension,
} from "../page-mention";

// ── Fixtures ───────────────────────────────────────────────────────────

const people: PersonMentionItem[] = [
  { kind: "person", id: "u1", name: "Jane Doe", email: "jane@example.com" },
  { kind: "person", id: "u2", name: "Mark Lee", email: "mark@example.com" },
];

const pages: PageMentionItem[] = [
  { kind: "page", id: "p1", title: "Q4 plan" },
  { kind: "page", id: "p2", title: "Roadmap" },
];

function mountPopup(propsOverrides: Partial<React.ComponentProps<typeof MentionPopup>> = {}): string {
  return renderToStaticMarkup(
    <MentionPopup
      people={people}
      pages={pages}
      onSelect={() => {}}
      {...propsOverrides}
    />,
  );
}

// ── Pure keyboard helpers ──────────────────────────────────────────────

describe("[COMP:app-web/mention-popup] nextSelectionIndex", () => {
  it("wraps to 0 after the last item on ArrowDown", () => {
    expect(nextSelectionIndex(1, 2, 1)).toBe(0);
  });

  it("wraps to the last item from 0 on ArrowUp", () => {
    expect(nextSelectionIndex(0, 3, -1)).toBe(2);
  });

  it("stays at 0 when the list is empty", () => {
    expect(nextSelectionIndex(0, 0, 1)).toBe(0);
    expect(nextSelectionIndex(5, 0, -1)).toBe(0);
  });
});

describe("[COMP:app-web/mention-popup] nextTab", () => {
  it("cycles people → pages on Tab", () => {
    expect(nextTab("people", 1)).toBe("pages");
  });

  it("cycles pages → people on Tab (wrap)", () => {
    expect(nextTab("pages", 1)).toBe("people");
  });

  it("cycles in the reverse direction on Shift+Tab", () => {
    expect(nextTab("people", -1)).toBe("pages");
    expect(nextTab("pages", -1)).toBe("people");
  });
});

// ── Popup SSR markup ───────────────────────────────────────────────────

describe("[COMP:app-web/mention-popup] MentionPopup render", () => {
  it("renders both tabs with the People tab active by default", () => {
    const html = mountPopup();
    // Both tab buttons present.
    expect(html).toMatch(/data-tab="people"/);
    expect(html).toMatch(/data-tab="pages"/);
    // People is active.
    expect(html).toMatch(/data-tab="people"[^>]*data-active/);
    // Panel shows people.
    expect(html).toMatch(/data-tab-panel="people"/);
  });

  it("respects initialTab='pages' for the pages tab", () => {
    const html = mountPopup({ initialTab: "pages" });
    expect(html).toMatch(/data-tab="pages"[^>]*data-active/);
    expect(html).toMatch(/data-tab-panel="pages"/);
  });

  it("renders one button per person row with data-item-id + kind", () => {
    const html = mountPopup();
    // People tab is active so people rows render.
    expect(html).toMatch(/data-item-id="u1"/);
    expect(html).toMatch(/data-item-id="u2"/);
    expect(html).toMatch(/data-item-kind="person"/);
    // Name + email both surface.
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
  });

  it("renders the empty-state marker when both lists are empty", () => {
    const html = renderToStaticMarkup(
      <MentionPopup people={[]} pages={[]} onSelect={() => {}} />,
    );
    expect(html).toMatch(/data-mention-popup="empty"/);
  });

  it("renders the pages tab with the page-mention rows when initialTab='pages'", () => {
    const html = mountPopup({ initialTab: "pages" });
    expect(html).toMatch(/data-item-id="p1"/);
    expect(html).toMatch(/data-item-id="p2"/);
    expect(html).toMatch(/data-item-kind="page"/);
    expect(html).toContain("Q4 plan");
  });

  it("threads localised labels into the tabs + aria", () => {
    const labels = {
      people: "メンバー",
      pages: "ページ",
      empty: "一致するものがありません",
      aria: "メンション候補",
    };
    const html = mountPopup({ labels });
    expect(html).toContain("メンバー");
    expect(html).toContain("ページ");
    expect(html).toContain('aria-label="メンション候補"');
  });
});

// ── PersonMentionNode contract ─────────────────────────────────────────

describe("[COMP:app-web/person-mention] PersonMentionNode", () => {
  it("is registered as an inline atom named 'personMention'", () => {
    expect(PersonMentionNode.name).toBe("personMention");
    // The base Tiptap Node carries its schema settings on `.config`.
    expect(PersonMentionNode.config.group).toBe("inline");
    expect(PersonMentionNode.config.inline).toBe(true);
    expect(PersonMentionNode.config.atom).toBe(true);
  });

  it("renders an `@Name` pill via the renderText contract", () => {
    // Cast through `unknown` — the runtime contract is `{ attrs }` even
    // though Tiptap's signature expects a full ProseMirror Node.
    const text = (PersonMentionNode.config.renderText as unknown as (
      args: { node: { attrs: Record<string, unknown> } },
    ) => string)({
      node: { attrs: { id: "u1", name: "Jane Doe" } },
    });
    expect(text).toBe("@Jane Doe");
  });
});

// ── PageMentionNode contract ───────────────────────────────────────────

describe("[COMP:app-web/page-mention] PageMentionNode", () => {
  it("is registered as an inline atom named 'pageMention'", () => {
    expect(PageMentionNode.name).toBe("pageMention");
    expect(PageMentionNode.config.group).toBe("inline");
    expect(PageMentionNode.config.inline).toBe(true);
    expect(PageMentionNode.config.atom).toBe(true);
  });

  it("renders a `📄 Title` text shape and `/p/<id>` href in the DOM spec", () => {
    // `renderText` accepts `{ node }` with `attrs`. Cast through `unknown`
    // — the runtime contract is `{ attrs }` even though Tiptap's signature
    // expects a full ProseMirror Node.
    const text = (PageMentionNode.config.renderText as unknown as (
      args: { node: { attrs: Record<string, unknown> } },
    ) => string)({
      node: { attrs: { id: "p1", title: "Q4 plan" } },
    });
    expect(text).toBe("📄 Q4 plan");

    const dom = (PageMentionNode.config.renderHTML as unknown as (
      args: {
        node: { attrs: Record<string, unknown> };
        HTMLAttributes: Record<string, unknown>;
      },
    ) => unknown[])({
      node: { attrs: { id: "p1", title: "Q4 plan" } },
      HTMLAttributes: {},
    });
    // ProseMirror DOMOutputSpec: [ tag, attrs, ...children ]
    expect(dom[0]).toBe("a");
    expect(dom[1]).toMatchObject({ "data-mention": "page", href: "/p/p1" });
  });
});

// ── Extension factories ────────────────────────────────────────────────

describe("[COMP:app-web/person-mention] createPersonMentionExtension", () => {
  it("returns an extension named 'personMention' that captures the workspaceId", () => {
    const fetchMembers = vi.fn().mockResolvedValue([]);
    const ext = createPersonMentionExtension({
      workspaceId: "w_abc",
      fetchMembers,
    });
    // The extended Node still carries the base name.
    expect(ext.name).toBe("personMention");
    // The fetcher is closed-over — calling it through the extension's
    // build path requires a live editor. The factory at minimum should
    // return something that the editor can install.
    expect(typeof ext.configure).toBe("function");
  });
});

describe("[COMP:app-web/page-mention] createPageMentionExtension", () => {
  it("returns an extension named 'pageMention' with schema-only default", () => {
    const ext = createPageMentionExtension();
    expect(ext.name).toBe("pageMention");
  });

  it("renders a workspace-scoped `/w/<wid>/p/<id>` href when given a workspaceId", () => {
    type RenderHTML = (args: {
      node: { attrs: Record<string, unknown> };
      HTMLAttributes: Record<string, unknown>;
    }) => unknown[];
    const renderArgs = {
      node: { attrs: { id: "p1", title: "Q4 plan" } },
      HTMLAttributes: {},
    };

    const scoped = createPageMentionExtension({ workspaceId: "w_abc" });
    const dom = (scoped.config.renderHTML as unknown as RenderHTML)(renderArgs);
    expect(dom[0]).toBe("a");
    expect(dom[1]).toMatchObject({
      "data-mention": "page",
      href: "/w/w_abc/p/p1",
    });

    // Without a workspaceId (schema-only test editors) the base-identical
    // relative href stays as the fallback.
    const bare = createPageMentionExtension();
    const bareDom = (bare.config.renderHTML as unknown as RenderHTML)(renderArgs);
    expect(bareDom[1]).toMatchObject({ href: "/p/p1" });
  });

  it("accepts withSuggestion: true alongside a fetchPages resolver", () => {
    const fetchPages = vi.fn().mockResolvedValue([]);
    const ext = createPageMentionExtension({
      workspaceId: "w_abc",
      fetchPages,
      withSuggestion: true,
    });
    expect(ext.name).toBe("pageMention");
  });
});
