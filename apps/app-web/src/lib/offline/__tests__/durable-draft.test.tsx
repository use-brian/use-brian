// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi } from "vitest";
const fixture = vi.hoisted(() => ({ viewerId: "a" }));
vi.mock("../application-write-authority", () => ({ currentOfflineWriteAuthority: () => ({ apiOrigin: "https://api.example", viewerId: fixture.viewerId }) }));
import { useDurableDraft } from "../use-durable-draft";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
describe("[COMP:app-web/durable-draft] restart and identity", () => {
  it("persists before returning, restores after remount, isolates accounts and reports quota failure", async () => {
    localStorage.clear(); fixture.viewerId = "a";
    const el = document.createElement("div"); let root = createRoot(el);
    let draft!: ReturnType<typeof useDurableDraft>;
    function Harness() { draft = useDurableDraft("workspace", "page:one", fixture.viewerId); return null; }
    await act(async () => root.render(<Harness />));
    act(() => draft[1]("Unsent offline text"));
    expect(Object.values(localStorage)).toContain("Unsent offline text");
    act(() => root.unmount()); root = createRoot(el);
    await act(async () => root.render(<Harness />)); expect(draft[0]).toBe("Unsent offline text");
    const oldSetter = draft[1]; fixture.viewerId = "b";
    await act(async () => root.render(<Harness />)); expect(draft[0]).toBe("");
    act(() => oldSetter(""));
    fixture.viewerId = "a"; await act(async () => root.render(<Harness />)); expect(draft[0]).toBe("Unsent offline text");
    const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    act(() => draft[1]("Still in editor")); expect(draft[0]).toBe("Still in editor"); expect(draft[2]).toBe(true);
    fail.mockRestore(); act(() => root.unmount());
  });
});
