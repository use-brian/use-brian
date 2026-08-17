// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import { PresentationPresenter } from "../presentation-presenter";
import { presentationFixture } from "./editor-fixtures";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("[COMP:app-web/office-presentation-editor] Presenter controls", () => {
  let host: HTMLDivElement;
  let mountedRoot: Root | null;
  beforeEach(() => {
    vi.useFakeTimers();
    mountedRoot = null;
    host = document.createElement("div");
    document.body.append(host);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  });
  afterEach(() => {
    if (mountedRoot) act(() => mountedRoot?.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount() {
    const snapshot = presentationFixture();
    snapshot.slides.push({ ...structuredClone(snapshot.slides[0]), id: "00000000-0000-4000-8000-000000000299", title: "Second", notes: [] });
    const onClose = vi.fn();
    const root = createRoot(host);
    mountedRoot = root;
    act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><PresentationPresenter snapshot={snapshot} onClose={onClose} /></I18nProvider>));
    return { root, onClose };
  }

  it("navigates by keyboard, resets elapsed time, and always exits on Escape", () => {
    const { onClose } = mount();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(host.textContent).toContain("0:02");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true })));
    expect(host.textContent).toContain("2 / 2");
    const reset = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.resetTimer}"]`)!;
    act(() => reset.click());
    expect(host.textContent).toContain("0:00");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("draws a reduced-motion laser pointer and pauses auto-advance on manual navigation", async () => {
    mount();
    const laser = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.laserPointer))!;
    act(() => laser.click());
    const presenter = host.querySelector<HTMLElement>("[data-office-presenter]")!;
    Object.defineProperty(presenter, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) });
    act(() => presenter.dispatchEvent(new PointerEvent("pointermove", { clientX: 25, clientY: 50, bubbles: true })));
    expect(host.querySelector<HTMLElement>("[data-presentation-laser]")?.className).toContain("motion-reduce:animate-none");
    expect(presenter.dataset.reducedMotion).toBe("true");

    const auto = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.autoAdvance}"]`)!;
    await act(async () => { auto.click(); });
    const five = [...document.body.querySelectorAll<HTMLElement>("[role='option']")].find((option) => option.textContent === en.office.autoAdvanceSeconds.replace("{seconds}", "5"))!;
    await act(async () => {
      five.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      five.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await act(async () => { five.click(); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(host.textContent).toContain("2 / 2");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true })));
    expect(host.textContent).toContain("1 / 2");
    expect(host.textContent).toContain(en.office.resumeAutoAdvance);
  });

  it("keeps focused controls visible, then hides them after focus leaves", () => {
    mount();
    const controls = host.querySelector<HTMLElement>("[data-presenter-controls-visible]")!;
    const laser = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.laserPointer))!;
    act(() => laser.focus());
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(controls.dataset.presenterControlsVisible).toBe("true");

    const presenter = host.querySelector<HTMLElement>("[data-office-presenter]")!;
    act(() => presenter.focus());
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(controls.dataset.presenterControlsVisible).toBe("false");
  });

  it("enters fullscreen by keyboard and exits from the always-available control", async () => {
    mount();
    const presenter = host.querySelector<HTMLElement>("[data-office-presenter]")!;
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
    const requestFullscreen = vi.fn(async () => {
      fullscreenElement = presenter;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitFullscreen = vi.fn(async () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Object.defineProperty(presenter, "requestFullscreen", { configurable: true, value: requestFullscreen });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });

    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", cancelable: true })));
    expect(requestFullscreen).toHaveBeenCalledOnce();
    const fullscreen = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(en.office.fullscreen))!;
    expect(fullscreen.getAttribute("aria-pressed")).toBe("true");
    await act(async () => fullscreen.click());
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});
