// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { InfoTip } from "@/components/workflow/field";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

describe("[COMP:app-web/workflow] InfoTip", () => {
  it("reveals its hint as soon as the pointer enters", () => {
    vi.useFakeTimers();
    mount(<InfoTip text="Explains this workflow setting." />);

    const trigger = container!.querySelector("button") as HTMLButtonElement;
    const pointerEnter = new Event("pointerover", { bubbles: true });
    Object.defineProperty(pointerEnter, "pointerType", { value: "mouse" });

    act(() => {
      trigger.dispatchEvent(pointerEnter);
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });

    expect(
      Array.from(document.querySelectorAll("[data-open]")).some((element) =>
        element.textContent?.includes("Explains this workflow setting."),
      ),
    ).toBe(true);
  });

  it("is keyboard reachable and reveals its hint on keyboard focus", () => {
    vi.useFakeTimers();
    mount(<InfoTip text="Explains this workflow setting." />);

    const trigger = container!.querySelector("button") as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.tabIndex).toBe(0);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      trigger.focus();
      vi.advanceTimersByTime(350);
    });

    const popup = Array.from(document.querySelectorAll("[data-open]")).find((element) =>
      element.textContent?.includes("Explains this workflow setting."),
    );
    expect(popup).toBeTruthy();
  });
});
