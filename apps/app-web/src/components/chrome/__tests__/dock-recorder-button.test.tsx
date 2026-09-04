// @vitest-environment jsdom
/**
 * [COMP:app-web/dock-recorder] — the idle split record affordance. The main
 * segment must retain the press gesture, while the computer-audio segment is
 * capability-gated and only changes the next-capture preference.
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const pickerMocks = vi.hoisted(() => ({
  listCaptureSources: vi.fn(),
  confirmDialog: vi.fn(),
}));

vi.mock("@/lib/desktop-auth-source", () => ({
  desktopBridge: () => ({
    listCaptureSources: pickerMocks.listCaptureSources,
  }),
}));

vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: (...args: unknown[]) => pickerMocks.confirmDialog(...args),
}));

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recorder: {
      start: "Record",
      audioOptions: "Recording audio options",
      includeComputerAudio: "Include computer audio",
      streamToPage: "Stream transcript and notes to a page",
    },
  }),
}));

vi.mock("@/components/ui/tooltip", async () => {
  const React = await import("react");
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

// Keep this test about DockRecorderButton's conditional UI + API wiring. The
// shared Base UI primitives own their own interaction tests.
vi.mock("@/components/ui/popover", async () => {
  const React = await import("react");
  return {
    Popover: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    PopoverTrigger: ({
      render,
      children,
    }: {
      render: React.ReactElement;
      children: React.ReactNode;
    }) => React.cloneElement(render, {}, children),
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", null, children),
  };
});

vi.mock("@/components/ui/switch", async () => {
  const React = await import("react");
  return {
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      id?: string;
      "aria-label"?: string;
    }) =>
      React.createElement("button", {
        ...props,
        type: "button",
        role: "switch",
        "aria-checked": String(checked),
        onClick: () => onCheckedChange(!checked),
      }),
  };
});

import {
  DockRecorderButton,
  pickCaptureSource,
} from "../dock-recorder";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  pickerMocks.listCaptureSources.mockReset();
  pickerMocks.confirmDialog.mockReset();
});

function recorder(overrides: Partial<DockRecorderApi> = {}): DockRecorderApi {
  return {
    phase: { kind: "idle" },
    active: false,
    elapsedMs: () => 0,
    notice: null,
    clearNotices: vi.fn(),
    onPressStart: vi.fn(),
    onPressEnd: vi.fn(),
    stop: vi.fn(),
    discard: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    level: () => 0,
    computerAudioAvailable: false,
    includeComputerAudio: false,
    setIncludeComputerAudio: vi.fn(),
    livePageEnabled: false,
    setLivePageEnabled: vi.fn(),
    includesSystemAudio: () => false,
    screenCaptureAvailable: false,
    capturePickerAvailable: false,
    captureSource: "mic" as const,
    setCaptureSource: () => {},
    capturesScreen: () => false,
    recovery: [],
    saveRecovery: vi.fn(),
    discardRecovery: vi.fn(),
    ...overrides,
  };
}

function mount(rec: DockRecorderApi): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DockRecorderButton rec={rec} />));
}

describe("[COMP:app-web/dock-recorder] DockRecorderButton", () => {
  it("offers live page streaming in browsers and old shells", () => {
    mount(recorder());
    expect(container!.querySelector('[aria-label="Record"]')).toBeTruthy();
    expect(
      container!.querySelector('[aria-label="Recording audio options"]'),
    ).toBeTruthy();
    expect(
      container!.querySelector('[aria-label="Stream transcript and notes to a page"]'),
    ).toBeTruthy();
  });

  it("starts capture from the main segment without opening an options step", () => {
    const onPressStart = vi.fn();
    mount(recorder({ onPressStart }));
    const button = container!.querySelector(
      '[aria-label="Record"]',
    ) as HTMLButtonElement;
    act(() =>
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
    );
    expect(onPressStart).toHaveBeenCalledTimes(1);
  });

  it("shows the desktop chevron and wires its switch to the remembered choice", () => {
    const setIncludeComputerAudio = vi.fn();
    mount(
      recorder({
        computerAudioAvailable: true,
        includeComputerAudio: true,
        setIncludeComputerAudio,
      }),
    );

    expect(
      container!.querySelector('[aria-label="Recording audio options"]'),
    ).toBeTruthy();
    const toggle = container!.querySelector(
      '[aria-label="Include computer audio"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(setIncludeComputerAudio).toHaveBeenCalledWith(false);
  });

  it("wires the live page option without changing audio capture yet", () => {
    const setLivePageEnabled = vi.fn();
    mount(recorder({ setLivePageEnabled }));
    const toggle = container!.querySelector(
      '[aria-label="Stream transcript and notes to a page"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => toggle.click());
    expect(setLivePageEnabled).toHaveBeenCalledWith(true);
  });
});

const pickerCopy = {
  capturePickerTitle: "Choose what to record",
  capturePickerBody: "Choose a screen or window.",
  capturePickerAction: "Start recording",
  capturePickerEmpty: "No shareable screens or windows were found.",
  capturePickerScreenTab: "Screen",
  capturePickerWindowTab: "Window",
  capturePickerScreenList: "Available screens",
  capturePickerWindowList: "Available windows",
  capturePickerScreenEmpty: "No shareable screens were found.",
  capturePickerWindowEmpty: "No shareable windows were found.",
};

describe("[COMP:app-web/dock-recorder] desktop capture-source picker", () => {
  it("shows screen and window cards, then returns the explicitly confirmed source", async () => {
    pickerMocks.listCaptureSources.mockImplementation(async (kind: "screen" | "window") =>
      kind === "screen"
        ? [{ id: "screen:1", name: "Built-in Display" }]
        : [
            { id: "window:1", name: "Browser" },
            { id: "window:2", name: "Editor" },
          ],
    );
    pickerMocks.confirmDialog.mockImplementation(
      async (options: {
        title?: string;
        description: string;
        confirmLabel?: string;
        content?: ReactNode;
      }) => {
        expect(options).toMatchObject({
          title: "Choose what to record",
          description: "Choose a screen or window.",
          confirmLabel: "Start recording",
        });
        const dialogHost = document.createElement("div");
        document.body.appendChild(dialogHost);
        const dialogRoot = createRoot(dialogHost);
        act(() => dialogRoot.render(options.content));

        const screenTab = dialogHost.querySelector('[role="tab"][aria-selected="true"]');
        expect(screenTab?.textContent).toContain("Screen");
        expect(dialogHost.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"))
          .toBe("Available screens");

        const windowTab = Array.from(dialogHost.querySelectorAll('[role="tab"]')).find(
          (button) => button.textContent?.includes("Window"),
        ) as HTMLButtonElement;
        act(() => windowTab.click());
        expect(dialogHost.querySelector('[role="radiogroup"]')?.getAttribute("aria-label"))
          .toBe("Available windows");

        const editor = Array.from(dialogHost.querySelectorAll('[role="radio"]')).find(
          (button) => button.textContent?.includes("Editor"),
        ) as HTMLButtonElement;
        act(() => editor.click());
        expect(editor.getAttribute("aria-checked")).toBe("true");

        act(() => dialogRoot.unmount());
        dialogHost.remove();
        return true;
      },
    );

    await expect(pickCaptureSource("screen", pickerCopy)).resolves.toEqual({
      source: "window",
      id: "window:2",
    });
    expect(pickerMocks.listCaptureSources).toHaveBeenCalledWith("screen");
    expect(pickerMocks.listCaptureSources).toHaveBeenCalledWith("window");
  });

  it("returns to idle semantics when the chooser is dismissed", async () => {
    pickerMocks.listCaptureSources.mockImplementation(async (kind: "screen" | "window") =>
      kind === "screen" ? [{ id: "screen:1", name: "Display" }] : [],
    );
    pickerMocks.confirmDialog.mockResolvedValue(false);

    await expect(pickCaptureSource("screen", pickerCopy)).resolves.toBeNull();
  });
});
