// @vitest-environment jsdom
/**
 * [COMP:app-web/drive-picker] Google Picker script readiness.
 *
 * The connector detail mounts one Picker trigger before its Settings tab.
 * Next.js caches the shared remote script, so that later trigger receives
 * `onReady` without a new `load` event. It must still become clickable.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scriptHarness = vi.hoisted(() => ({
  props: null as null | {
    onLoad?: () => void;
    onReady?: () => void;
  },
}));

vi.mock("next/script", () => ({
  default: (props: NonNullable<typeof scriptHarness.props>) => {
    scriptHarness.props = props;
    return null;
  },
}));

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    drivePicker: {
      connectFirst: "Connect first",
      noToken: "No token",
      notConfigured: "Not configured",
      loading: "Loading",
      pickerFailed: "Picker failed",
      loadingPicker: "Loading Picker",
    },
  }),
}));

import { DrivePicker } from "../drive-picker";

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let gapiLoad: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scriptHarness.props = null;
  gapiLoad = vi.fn((_name: string, ready: () => void) => ready());
  Object.defineProperty(window, "gapi", {
    configurable: true,
    value: { load: gapiLoad },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  Reflect.deleteProperty(window, "gapi");
});

describe("[COMP:app-web/drive-picker] script readiness", () => {
  it("enables a late-mounted trigger when the cached script reports onReady", async () => {
    await act(async () => {
      root!.render(
        <DrivePicker onPicked={() => {}}>
          {({ disabled }) => <button disabled={disabled}>Pick</button>}
        </DrivePicker>,
      );
    });

    const button = host!.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(scriptHarness.props?.onReady).toBeTypeOf("function");

    await act(async () => {
      scriptHarness.props!.onReady!();
    });

    expect(gapiLoad).toHaveBeenCalledWith("picker", expect.any(Function));
    expect(button.disabled).toBe(false);
  });
});
