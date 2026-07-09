// @vitest-environment jsdom
/**
 * [COMP:app-web/checkbox] — the themed base-ui checkbox that replaces the raw
 * native `<input type="checkbox">`. Verifies the three visual states map to the
 * right ARIA + the tick only mounts when ticked, and that a click reports the
 * toggle (unless disabled). If these break, the select-all / row multi-select
 * in the Brain reviews panel silently stops reflecting state.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Tell React this is an act-capable environment (jsdom + createRoot).
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { Checkbox } from "@/components/ui/checkbox";

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function box(): HTMLElement {
  return container!.querySelector('[role="checkbox"]') as HTMLElement;
}

describe("[COMP:app-web/checkbox] Checkbox primitive", () => {
  it("checked → aria-checked=true and the tick mounts", () => {
    mount(<Checkbox checked aria-label="pick" />);
    expect(box().getAttribute("aria-checked")).toBe("true");
    // The Indicator (and its svg tick) only render when ticked.
    expect(container!.querySelector("svg")).toBeTruthy();
  });

  it("unchecked → aria-checked=false and no tick is rendered", () => {
    mount(<Checkbox checked={false} aria-label="pick" />);
    expect(box().getAttribute("aria-checked")).toBe("false");
    expect(container!.querySelector("svg")).toBeNull();
  });

  it("indeterminate → aria-checked=mixed with a glyph", () => {
    mount(<Checkbox indeterminate aria-label="pick" />);
    expect(box().getAttribute("aria-checked")).toBe("mixed");
    expect(container!.querySelector("svg")).toBeTruthy();
  });

  it("a click reports the toggled value", () => {
    const onCheckedChange = vi.fn();
    mount(
      <Checkbox checked={false} onCheckedChange={onCheckedChange} aria-label="pick" />,
    );
    act(() => box().click());
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange.mock.calls[0][0]).toBe(true);
  });

  it("disabled swallows the click", () => {
    const onCheckedChange = vi.fn();
    mount(
      <Checkbox
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
        aria-label="pick"
      />,
    );
    act(() => box().click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
