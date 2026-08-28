// @vitest-environment jsdom
/**
 * [COMP:app-web/operator-filter-bar] Peek-resize width floor.
 *
 * `usePeekResize` gained an optional `minWidth` so inline rails narrower
 * than the record-panel default (the Feed plan rail's 320px baseline) can
 * resize below the shared 360px floor. The floor gates BOTH the drag clamp
 * and what a stored width is allowed to rehydrate to — a stale key from a
 * wider floor must fall back to the default width, never render a panel
 * narrower than its own minimum. Drag/pointer mechanics stay web-QA; this
 * file pins the storage-read contract the option changes.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { usePeekResize } from "../resizable-peek";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function Probe({
  storageKey,
  minWidth,
}: {
  storageKey: string;
  minWidth?: number;
}) {
  const { width } = usePeekResize(
    storageKey,
    minWidth === undefined ? undefined : { minWidth },
  );
  return <output>{width === null ? "null" : String(width)}</output>;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function renderProbe(props: { storageKey: string; minWidth?: number }): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Probe {...props} />);
  });
  return host.querySelector("output")?.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.localStorage.clear();
});

describe("[COMP:app-web/operator-filter-bar] usePeekResize width floor", () => {
  it("rehydrates a stored width at or above the shared 360px default", () => {
    window.localStorage.setItem("test:peek", "480");
    expect(renderProbe({ storageKey: "test:peek" })).toBe("480");
  });

  it("rejects a stored width below the floor (falls back to default width)", () => {
    window.localStorage.setItem("test:peek", "300");
    expect(renderProbe({ storageKey: "test:peek" })).toBe("null");
  });

  it("a custom minWidth admits widths the shared floor would reject", () => {
    window.localStorage.setItem("test:peek", "300");
    expect(renderProbe({ storageKey: "test:peek", minWidth: 280 })).toBe("300");
  });

  it("a custom minWidth still rejects widths below itself", () => {
    window.localStorage.setItem("test:peek", "260");
    expect(renderProbe({ storageKey: "test:peek", minWidth: 280 })).toBe(
      "null",
    );
  });

  it("garbage in storage is ignored", () => {
    window.localStorage.setItem("test:peek", "not-a-number");
    expect(renderProbe({ storageKey: "test:peek", minWidth: 280 })).toBe(
      "null",
    );
  });
});
