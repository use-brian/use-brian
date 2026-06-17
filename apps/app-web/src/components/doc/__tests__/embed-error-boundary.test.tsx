// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBoundary } from "../error-states";

/**
 * The data/chart embed subtree (`node-views/embed-view.tsx`) resolves a live
 * A2UI widget and paints it through `renderWidget`; a malformed payload can
 * throw synchronously during render. Before the embed node-view was wrapped in
 * the shared `ErrorBoundary`, that throw unwound React through the whole editor
 * and blanked the ENTIRE page (observed on a contacts-bound research page where
 * every other block was fine).
 *
 * These tests pin the containment contract the embed-view relies on: the shared
 * `ErrorBoundary` renders its `fallback` instead of rethrowing, healthy content
 * passes through, and a `key` change (the embed remounts on a new block id /
 * re-resolved attr) recovers in place. Mounted with raw `createRoot` + `act`
 * (app-web has no `@testing-library/react` dependency); the embed-view's own
 * fallback uses the `dataBlockFailed` string, so here we assert the boundary
 * plumbing with a plain fallback that needs no i18n provider.
 *
 * [COMP:app-web/data-embed]
 */
describe("[COMP:app-web/data-embed] Embed render-crash containment", () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(node));
    // When an error boundary catches a throw during the INITIAL concurrent
    // render, React schedules the fallback as a follow-up commit; a second
    // empty `act` flushes it so the fallback DOM is present before we assert.
    act(() => {});
  }

  function rerender(node: React.ReactNode) {
    act(() => root.render(node));
    act(() => {});
  }

  // A node-view child that throws during render, standing in for a widget that
  // chokes on a malformed cell/column/payload.
  function Boom(): never {
    throw new Error("widget render failed");
  }

  it("passes a healthy embed subtree through untouched", () => {
    mount(
      <ErrorBoundary fallback={() => <div>tombstone</div>}>
        <div>healthy block</div>
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("healthy block");
    expect(container.textContent).not.toContain("tombstone");
  });

  it("renders the fallback tombstone instead of crashing when the subtree throws", () => {
    // React logs caught render errors to console.error; the boundary also logs
    // its own diagnostic. Silence both so suite output stays clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
    mount(
      <ErrorBoundary fallback={() => <div>tombstone</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("tombstone");
  });

  it("logs the caught error so the underlying widget throw stays diagnosable", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mount(
      <ErrorBoundary fallback={() => <div>tombstone</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(
      spy.mock.calls.some((args) => String(args[0]).includes("ErrorBoundary caught")),
    ).toBe(true);
  });

  it("recovers in place when the block identity (key) changes after a crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The embed-view passes `key={blockId ?? raw}`; a changed attr remounts the
    // boundary, giving the repaired block a fresh render. Model that with key.
    mount(
      <ErrorBoundary key="block-a" fallback={() => <div>tombstone</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("tombstone");

    rerender(
      <ErrorBoundary key="block-b" fallback={() => <div>tombstone</div>}>
        <div>recovered block</div>
      </ErrorBoundary>,
    );
    expect(container.textContent).toContain("recovered block");
    expect(container.textContent).not.toContain("tombstone");
  });
});
