/**
 * [COMP:app-web/sidebar-tree-node] Nested sub-page tree row.
 *
 * vitest in app-web is node-only (no jsdom) — we mount through
 * `renderToString` (wrapped in a `<DndContext>` the row's draggable/droppable
 * hooks need) and assert against the static markup. The contract under test:
 * a draft row inside a **saved** (Favorites) subtree is *kept by ancestry*, so
 * it must NOT show the "Save page" CTA / prune countdown — while a draft with
 * no saved ancestor still does. This is the exact UX the screenshot bug
 * reported: a child under a saved parent should not need its own Save.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DndContext } from "@dnd-kit/core";

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { SidebarTreeNode } from "../sidebar-tree-node";
import type { TreeNode } from "@/lib/sidebar-tree";
import type { ViewListRow } from "@/lib/api/views";

const dict = en as unknown as Dictionary;
const noop = () => {};

// 28 days out (+1h cushion so Math.round in daysUntilPrune lands on 28).
const in28Days = new Date(Date.now() + 28 * 86_400_000 + 3_600_000).toISOString();

function draftNode(id: string): TreeNode {
  return {
    row: {
      id,
      name: id,
      icon: null,
      state: "draft",
      entity: null,
      viewType: null,
      nameOrigin: "placeholder",
      nestParentId: "saved-parent",
      position: 0,
    } as unknown as ViewListRow,
    children: [],
    depth: 1,
  };
}

function render(node: TreeNode, keptByAncestry: Set<string>): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <DndContext>
        <ul>
          <SidebarTreeNode
            node={node}
            activeId={node.row.id}
            expanded={{}}
            onToggleExpand={noop}
            onSelect={noop}
            onAddChild={noop}
            onRename={noop}
            onDuplicate={noop}
            onSave={noop}
            onUnsave={noop}
            onDelete={noop}
            onMoveToRoot={noop}
            draftPruneByid={{ [node.row.id]: in28Days }}
            keptByAncestry={keptByAncestry}
            draggingId={null}
          />
        </ul>
      </DndContext>
    </I18nProvider>,
  );
}

describe("[COMP:app-web/sidebar-tree-node] kept-by-ancestry suppression", () => {
  it("shows the Save CTA on a draft with no saved ancestor", () => {
    const node = draftNode("child");
    const html = render(node, new Set());
    expect(html).toContain("28d until auto-delete");
    expect(html).toContain(en.docPage.sidebarDraftSave); // "Save page"
  });

  it("suppresses the Save CTA + countdown when filed under a saved parent", () => {
    const node = draftNode("child");
    const html = render(node, new Set(["child"]));
    expect(html).not.toContain("until auto-delete");
    expect(html).not.toContain(en.docPage.sidebarDraftSave);
  });
});

describe("[COMP:app-web/sidebar-tree-node] Temporary-page icon ghost", () => {
  it("ghosts the icon on an auto-pruning draft", () => {
    const node = draftNode("child");
    const html = render(node, new Set());
    expect(html).toContain("doc-icon-temporary");
  });

  it("does not ghost a draft kept by a saved ancestor", () => {
    // Kept by ancestry → spared by the prune worker, so it is not temporary.
    const node = draftNode("child");
    const html = render(node, new Set(["child"]));
    expect(html).not.toContain("doc-icon-temporary");
  });
});
