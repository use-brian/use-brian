// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
import { Button, buttonVariants } from "../button";
import { Checkbox } from "../checkbox";
import { Switch } from "../switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../select";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
const minimum = ["max-md:min-h-11", "max-md:min-w-11", "[@media(pointer:coarse)]:min-h-11", "[@media(pointer:coarse)]:min-w-11"];
function hasTarget(element: Element) {
  for (const token of minimum) expect(element.classList.contains(token), token).toBe(true);
}

describe("[COMP:app-web/button] [COMP:app-web/checkbox] [COMP:app-web/switch] [COMP:app-web/select] F07 phone targets", () => {
  it("compiles phone and coarse target rules, including both breakpoint edges", async () => {
    // Compile the actual source tokens, not a second handwritten CSS fixture.
    // jsdom cannot lay out or hit-test pseudo-elements; this is a CSS contract.
    const source = ["button", "select", "checkbox", "switch"].map(name =>
      readFileSync(resolve(process.cwd(), "src/components/ui", `${name}.tsx`), "utf8")).join(" ");
    const candidates = [...new Set(source.split(/[\s\"'`]+/))];
    const compiler = await compile("@theme { --breakpoint-md: 48rem; --spacing: 0.25rem; } @tailwind utilities;");
    const css = compiler.build(candidates);
    expect(css).not.toContain("width < 40rem");
    expect(css).toContain("@media (width < 48rem)");
    expect(css).toContain("@media (pointer:coarse)");
    expect(css).toContain("min-height: calc(var(--spacing) * 11)");
    expect(css).toContain("width: max(100%, 44px)");
    expect(css).toContain("height: max(100%, 44px)");
    const breakpoint = Number(css.match(/@media \(width < (\d+)rem\)/)![1]) * 16;
    expect([639, 640, 767, 768].map(width => width < breakpoint)).toEqual([true, true, true, false]);
  });

  it("allocates all button targets in normal flow without growing icon glyphs", () => {
    const sizes = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
    for (const size of sizes) {
      const tokens = buttonVariants({ size }).split(" ");
      for (const token of minimum) expect(tokens).toContain(token);
      expect(tokens).toContain("[&_svg:not([class*='size-'])]:size-4");
    }
    mount(<Button size="icon-xs" aria-label="Add" className="size-5" />);
    const button = container!.querySelector("button")!;
    hasTarget(button);
    expect(button.classList.contains("size-5")).toBe(true);
    expect(button.classList.contains("size-6")).toBe(false);
  });

  it("keeps compact checkbox paint/custom classes and reserves its pseudo-target separately", () => {
    mount(<Checkbox defaultChecked className="size-3.5 mt-0.5" aria-label="Pick" />);
    const box = container!.querySelector('[role="checkbox"]')!;
    hasTarget(box.parentElement!);
    expect(box.classList.contains("size-3.5")).toBe(true);
    expect(box.classList.contains("size-4")).toBe(false);
    expect(box.classList.contains("mt-0.5")).toBe(true);
    expect(box.classList.contains("max-md:after:size-[max(100%,44px)]")).toBe(true);
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.querySelector("svg")!.classList.contains("size-full")).toBe(true);
  });

  it.each([Checkbox, Switch])("preserves labels, root/input refs, form values and exactly-once state changes (%#)", (Control) => {
    const ref = createRef<HTMLElement>();
    const inputRef = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    mount(<form><label htmlFor="toggle">Enable</label><Control id="toggle" name="enabled" ref={ref} inputRef={inputRef} onCheckedChange={onChange} /></form>);
    expect(ref.current!.getAttribute("role")).toMatch(/checkbox|switch/);
    expect(inputRef.current!.type).toBe("checkbox");
    act(() => container!.querySelector("label")!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ref.current!.getAttribute("aria-checked")).toBe("true");
    expect(new FormData(container!.querySelector("form")!).get("enabled")).toBe("on");
  });

  it.each([Checkbox, Switch])("preserves Space keyboard toggling (%#)", (Control) => {
    const change = vi.fn();
    mount(<Control onCheckedChange={change} aria-label="Enable" />);
    const control = container!.querySelector('[role="checkbox"], [role="switch"]') as HTMLElement;
    act(() => {
      control.focus();
      control.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
      control.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
    });
    expect(change).toHaveBeenCalledTimes(1);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps switch track and checked-thumb geometry independent of its target", () => {
    mount(<Switch defaultChecked className={state => state.checked ? "custom-checked" : "custom-unchecked"} />);
    const control = container!.querySelector('[role="switch"]')!;
    hasTarget(control.parentElement!);
    expect(control.classList.contains("h-5")).toBe(true);
    expect(control.classList.contains("w-9")).toBe(true);
    expect(control.classList.contains("custom-checked")).toBe(true);
    const thumb = control.querySelector('[data-slot="switch-thumb"]')!;
    expect(thumb.classList.contains("size-4")).toBe(true);
    expect(thumb.classList.contains("data-[checked]:translate-x-4")).toBe(true);
    expect(thumb.hasAttribute("data-checked")).toBe(true);
  });

  it.each([Checkbox, Switch])("leaves disabled controls inert even with an expanded target (%#)", (Control) => {
    const change = vi.fn();
    mount(<label><Control disabled onCheckedChange={change} />Enable</label>);
    act(() => {
      (container!.querySelector('[role="checkbox"], [role="switch"]') as HTMLElement).click();
      container!.querySelector("label")!.click();
    });
    expect(change).not.toHaveBeenCalled();
  });

  it("sizes both select trigger variants and choice rows, with 16px phone choice text", () => {
    mount(<Select defaultValue="one" open items={[{ value: "one", label: "One" }]}>
      <SelectTrigger size="sm" aria-label="Choice"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="one">One</SelectItem></SelectContent>
    </Select>);
    const trigger = container!.querySelector('[data-slot="select-trigger"]')!;
    hasTarget(trigger);
    expect(trigger.classList.contains("max-md:text-base")).toBe(true);
    expect(trigger.classList.contains("data-[size=sm]:h-7")).toBe(true);
    const option = document.querySelector('[data-slot="select-item"]')!;
    expect(option.classList.contains("max-md:min-h-11")).toBe(true);
    expect(option.classList.contains("max-md:text-base")).toBe(true);
    expect(option.getAttribute("aria-selected")).toBe("true");
  });
});
