// @vitest-environment jsdom
/**
 * [COMP:app-web/doc-tabs-session] Tab strip survival across a surface switch.
 *
 * `<DocShell>` is mounted by `/w/[id]/p/layout.tsx`, which is UNMOUNTED the
 * moment the user leaves the doc surface for Brain / Studio / Workflow (those
 * live under the workspace layout, a sibling of `p/`). These tests drive that
 * exact lifecycle — mount, mutate the strip, unmount, remount — against the
 * real hook, with a fake router that models `router.replace` the way Next does
 * (the pathname changes, the component re-renders with a new `urlEntry`).
 *
 * The pure reducer behind the strip is covered in `doc-tabs.test.ts`; what is
 * covered here is only the part a pure test cannot reach: the seed ⇄ URL
 * reconciliation across a remount.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { activePageId, newTab, openPage, type TabsState } from "../doc-tabs";
import { useDocTabs } from "../use-doc-tabs";
import { resetDocTabsSession } from "../doc-tabs-session";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const WS = "ws-1";

type Api = {
  state: TabsState;
  setState: React.Dispatch<React.SetStateAction<TabsState>>;
};

/**
 * One mount of the doc surface, with a fake URL bar. `url` stands in for the
 * pathname: the hook writes to it via `syncUrl`, and `settle()` re-renders
 * until the two directions agree — the same convergence the real router +
 * `usePathname()` produce.
 */
function mountSurface(workspaceId: string, initialUrl: string | null) {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let url = initialUrl;
  let api: Api | null = null;

  function Probe({ entry }: { entry: string | null }) {
    const [state, setState] = useDocTabs(workspaceId, entry, (next) => {
      url = next;
    });
    api = { state, setState };
    return null;
  }

  function settle() {
    for (let i = 0; i < 8; i += 1) {
      const before = url;
      act(() => {
        root.render(<Probe entry={url} />);
      });
      if (url === before) return;
    }
    throw new Error("url never settled — tabs ⇄ URL are ping-ponging");
  }

  settle();

  return {
    get state() {
      if (!api) throw new Error("not mounted");
      return api.state;
    },
    get url() {
      return url;
    },
    /** Apply a reducer action the way a top-bar button would, then converge. */
    dispatch(fn: (s: TabsState) => TabsState) {
      act(() => {
        api!.setState(fn);
      });
      settle();
    },
    /** An EXTERNAL navigation (sidebar row, deep link) landing on this mount. */
    navigate(entry: string | null) {
      url = entry;
      settle();
    },
    /** Leave the doc surface — Next tears `p/layout.tsx` down. */
    unmount() {
      act(() => {
        root.unmount();
      });
    },
  };
}

describe("[COMP:app-web/doc-tabs-session] Doc tab strip across a surface switch", () => {
  beforeEach(() => {
    resetDocTabsSession();
  });

  it("keeps the open tabs when the user goes to Brain and back to Home", () => {
    // Home, then `+` and open a page in the new tab — two tabs open.
    const first = mountSurface(WS, null);
    first.dispatch(newTab);
    first.dispatch((s) => openPage(s, "page-2"));
    expect(first.state.tabs).toHaveLength(2);
    expect(first.url).toBe("page-2");

    // → Brain / Studio / Workflow: the doc surface unmounts.
    first.unmount();

    // ← Home. The nav rail targets `/w/<id>/p`, so the URL carries no page.
    const back = mountSurface(WS, null);

    expect(back.state.tabs).toHaveLength(2);
    expect(activePageId(back.state)).toBe("page-2");
    // The restored strip is the source of truth: the URL follows it back.
    expect(back.url).toBe("page-2");
  });

  it("adopts a deep link into the restored strip instead of dropping it", () => {
    const first = mountSurface(WS, null);
    first.dispatch(newTab);
    first.dispatch((s) => openPage(s, "page-2"));
    first.unmount();

    // Re-entering by clicking a sidebar page from Brain: the URL wins for the
    // active tab, the strip still survives.
    const back = mountSurface(WS, "page-9");

    expect(back.state.tabs).toHaveLength(2);
    expect(activePageId(back.state)).toBe("page-9");
    expect(back.url).toBe("page-9");
  });

  it("scopes the strip to one workspace", () => {
    const first = mountSurface(WS, null);
    first.dispatch(newTab);
    first.dispatch((s) => openPage(s, "page-2"));
    first.unmount();

    const other = mountSurface("ws-2", null);

    expect(other.state.tabs).toHaveLength(1);
    expect(activePageId(other.state)).toBeNull();
  });

  it("still blanks the active tab when Home is clicked from inside the surface", () => {
    // Home is a live navigation while mounted — it must keep behaving like the
    // browser's home button (blank the ACTIVE tab, keep the strip).
    const s = mountSurface(WS, null);
    s.dispatch(newTab);
    s.dispatch((t) => openPage(t, "page-2"));

    s.navigate(null);

    expect(s.state.tabs).toHaveLength(2);
    expect(activePageId(s.state)).toBeNull();
    expect(s.url).toBeNull();
  });
});
