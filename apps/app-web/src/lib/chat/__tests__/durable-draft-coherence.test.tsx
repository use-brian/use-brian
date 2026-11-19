// @vitest-environment jsdom
/** [COMP:app-web/durable-draft] Same-tab mounts of one draft key stay coherent. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: () => ({ apiOrigin: "https://api.example", viewerId: "viewer-1" }) }));
import { useDurableDraft } from "@/lib/offline/use-durable-draft";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/durable-draft] same-tab coherence", () => {
  it("a dock and a drawer on one key see each other's writes; other keys are untouched", async () => {
    localStorage.clear();
    const el = document.createElement("div");
    const root = createRoot(el);
    const drafts: Record<string, ReturnType<typeof useDurableDraft>> = {};
    function Mount({ name, composer }: { name: string; composer: string }) { drafts[name] = useDurableDraft("workspace-1", composer); return null; }
    await act(async () => root.render(<>
      <Mount name="dock" composer="dock:/p/one" />
      <Mount name="drawer" composer="dock:/p/one" />
      <Mount name="other" composer="dock:/p/two" />
    </>));
    act(() => drafts.dock![1]("Typed in the dock"));
    expect(drafts.drawer![0]).toBe("Typed in the dock");
    expect(drafts.other![0]).toBe("");
    // The stale sibling's functional update builds on the current text.
    act(() => drafts.drawer![1]((text) => `${text}, then the drawer`));
    expect(drafts.dock![0]).toBe("Typed in the dock, then the drawer");
    expect(Object.values(localStorage)).toContain("Typed in the dock, then the drawer");
    act(() => drafts.dock![1](""));
    expect(drafts.drawer![0]).toBe("");
    act(() => root.unmount());
  });
});
