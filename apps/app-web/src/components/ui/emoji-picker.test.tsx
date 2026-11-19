// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { CaretEmojiPicker, EmojiPicker } from "./emoji-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Options = { theme: string; perLine: number; onEmojiSelect: (emoji: { native: string }) => void };
type MockPicker = HTMLDivElement & { update: ReturnType<typeof vi.fn> };
const mart = vi.hoisted(() => ({ instances: [] as { element: MockPicker; options: Options }[], dataLoads: 0 }));
vi.mock("@emoji-mart/data", () => {
  mart.dataLoads++;
  return { default: { emojis: {} } };
});
vi.mock("emoji-mart", () => ({
  Picker: class {
    constructor(options: Options) {
      const element = document.createElement("div") as MockPicker;
      element.dataset.mockPicker = "";
      const shadow = element.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      input.type = "search";
      shadow.append(input);
      element.update = vi.fn();
      mart.instances.push({ element, options });
      return element;
    }
  },
}));

let theme: ReturnType<typeof useTheme>;
function ThemeControls() {
  theme = useTheme();
  return null;
}

describe("[COMP:app-web/emoji-picker] resolved theme bridge", () => {
  let root: Root;
  let container: HTMLDivElement;
  let systemDark: boolean;
  let mediaChange: EventTarget;
  beforeEach(() => {
    mart.instances.length = 0;
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-palette");
    systemDark = false;
    mediaChange = new EventTarget();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query === "(prefers-color-scheme: dark)" && systemDark; },
      media: query,
      addEventListener: mediaChange.addEventListener.bind(mediaChange),
      removeEventListener: mediaChange.removeEventListener.bind(mediaChange),
      addListener() {}, removeListener() {}, dispatchEvent: mediaChange.dispatchEvent.bind(mediaChange),
    }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.removeAttribute("data-palette");
    document.documentElement.style.colorScheme = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function render(child: React.ReactNode, provider = true) {
    await act(async () => root.render(
      <I18nProvider locale="en" dict={en}>
        {provider ? <ThemeProvider><ThemeControls />{child}</ThemeProvider> : child}
      </I18nProvider>,
    ));
  }
  const caret = (onPick = vi.fn(), onClose = vi.fn()) => (
    <CaretEmojiPicker position={{ top: 40, left: 60 }} onPick={onPick} onClose={onClose} />
  );

  it("does not load emoji data or construct a picker while closed", async () => {
    await render(<EmojiPicker trigger={<button>Icon</button>} onPick={vi.fn()} />);
    expect(mart.dataLoads).toBe(0);
    expect(mart.instances).toHaveLength(0);
  });

  it.each(["light", "dark"] as const)("initializes the portalled icon picker in app %s mode", async (mode) => {
    localStorage.setItem("doc:theme", mode);
    const pick = vi.fn();
    const change = vi.fn();
    await render(<EmojiPicker trigger={<button>Page icon</button>} onPick={pick} open onOpenChange={change} />);
    expect(mart.instances).toHaveLength(1);
    const { options, element } = mart.instances[0];
    expect(options.theme).toBe(mode);
    expect(element.isConnected).toBe(true);
    expect(container.contains(element)).toBe(false); // actual Base UI portal
    await act(async () => options.onEmojiSelect({ native: "🌱" }));
    expect(pick).toHaveBeenCalledExactlyOnceWith("🌱");
    expect(change).toHaveBeenCalledWith(false);
  });

  it("updates the same shadow-root picker for light/dark and custom-mode changes without resetting focus/search", async () => {
    const observer = vi.spyOn(globalThis, "MutationObserver");
    await render(caret());
    const { element } = mart.instances[0];
    const input = element.shadowRoot!.querySelector("input")!;
    input.value = "smile";
    input.focus();
    const dataLoads = mart.dataLoads;
    await act(async () => theme.setMode("dark"));
    expect(element.update).toHaveBeenLastCalledWith({ theme: "dark" });
    await act(async () => theme.applyCustomTheme("custom-dark", { light: {}, dark: {} }, "light"));
    expect(element.update).toHaveBeenLastCalledWith({ theme: "light" });
    expect(mart.instances).toHaveLength(1);
    expect(mart.dataLoads).toBe(dataLoads);
    expect(input.value).toBe("smile");
    expect(element.shadowRoot!.activeElement).toBe(input);
    // The provider suffices in production: no DOM-theme observer there.
    expect(observer).not.toHaveBeenCalled();
  });

  it("uses resolved system mode and responds to OS changes while open", async () => {
    localStorage.setItem("doc:theme", "system");
    systemDark = true;
    await render(caret());
    expect(mart.instances[0].options.theme).toBe("dark");
    await act(async () => {
      systemDark = false;
      mediaChange.dispatchEvent(new Event("change"));
    });
    expect(mart.instances[0].element.update).toHaveBeenLastCalledWith({ theme: "light" });
    expect(mart.instances).toHaveLength(1);
  });

  it("keeps provider-free previews working and disconnects their scoped theme observer", async () => {
    document.documentElement.classList.add("dark");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    await render(caret(), false);
    const { element, options } = mart.instances[0];
    expect(options.theme).toBe("dark");
    await act(async () => { document.documentElement.classList.remove("dark"); });
    expect(element.update).toHaveBeenLastCalledWith({ theme: "light" });
    await act(async () => root.render(null));
    expect(element.isConnected).toBe(false);
    expect(disconnect).toHaveBeenCalled();
    element.update.mockClear();
    await act(async () => { document.documentElement.classList.add("dark"); });
    expect(element.update).not.toHaveBeenCalled();
  });

  it("keeps the latest caret selection callback, inside clicks, Escape and outside-dismiss behavior", async () => {
    const oldPick = vi.fn(), nextPick = vi.fn(), close = vi.fn();
    await render(caret(oldPick, close));
    await render(caret(nextPick, close));
    const { options, element } = mart.instances[0];
    await act(async () => options.onEmojiSelect({ native: "🚀" }));
    expect(oldPick).not.toHaveBeenCalled();
    expect(nextPick).toHaveBeenCalledExactlyOnceWith("🚀");
    await act(async () => element.shadowRoot!.querySelector("input")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true })));
    expect(close).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(close).toHaveBeenCalledTimes(2);
    await act(async () => root.render(null));
    close.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(close).not.toHaveBeenCalled();
    expect(element.isConnected).toBe(false);
  });

  it("preserves Remove and closes an uncontrolled page-icon popup after picking", async () => {
    const pick = vi.fn();
    await render(<EmojiPicker trigger={<button data-open-icon>Icon</button>} onPick={pick} />);
    await act(async () => container.querySelector<HTMLButtonElement>("[data-open-icon]")!.click());
    expect(mart.instances).toHaveLength(1);
    const remove = [...document.querySelectorAll("button")].find(button => button.textContent === en.docPage.emojiPicker.remove)!;
    await act(async () => remove.click());
    expect(pick).toHaveBeenCalledExactlyOnceWith(null);
    expect(mart.instances[0].element.isConnected).toBe(false);
  });
});
