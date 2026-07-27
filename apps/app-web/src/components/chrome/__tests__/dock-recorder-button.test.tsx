// @vitest-environment jsdom
/**
 * [COMP:app-web/dock-recorder] — the idle split record affordance. The main
 * segment must retain the press gesture, while the computer-audio segment is
 * capability-gated and only changes the next-capture preference.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    recorder: {
      start: "Record",
      audioOptions: "Recording audio options",
      includeComputerAudio: "Include computer audio",
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

import { DockRecorderButton } from "../dock-recorder";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
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
    includesSystemAudio: () => false,
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
  it("keeps browsers and old shells as the unchanged one-button mic UI", () => {
    mount(recorder());
    expect(container!.querySelectorAll("button")).toHaveLength(1);
    expect(container!.querySelector('[aria-label="Record"]')).toBeTruthy();
    expect(
      container!.querySelector('[aria-label="Recording audio options"]'),
    ).toBeNull();
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
      '[role="switch"]',
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(setIncludeComputerAudio).toHaveBeenCalledWith(false);
  });
});
