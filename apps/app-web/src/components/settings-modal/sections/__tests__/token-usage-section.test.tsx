// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { TokenUsageSection } from "../token-usage-section";

const state = vi.hoisted(() => ({ data: undefined as unknown, error: undefined as unknown, loading: true, revalidating: false, refresh: vi.fn() }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "ws1" }) }));
vi.mock("@/lib/surface-cache", () => ({ useCachedResource: () => state, SurfaceCacheEvictionError: Error }));
vi.mock("@/lib/surface-prefetch", () => ({ tokenUsageCacheKey: (id: string) => `usage:${id}` }));
const render = () => renderToString(<I18nProvider locale="en" dict={en}><TokenUsageSection /></I18nProvider>);

beforeEach(() => { state.data = undefined; state.error = undefined; state.loading = true; state.revalidating = false; });

describe("[COMP:app-web/token-usage] standalone telemetry", () => {
  it("renders a loading skeleton without billing actions", () => {
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('skeleton');
    expect(html).not.toMatch(/Buy extra|credits|payment/i);
  });
  it("shows a retryable error, not an empty-success state", () => {
    state.loading = false; state.error = new Error("failed");
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Refresh');
    expect(html).not.toContain(en.tokenUsage.empty);
  });
  it("shows model names, tokens, USD costs and the reporting window without cache cards", () => {
    state.loading = false;
    state.data = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z', estimatedCostUsd: 0.125, hasUnpricedUsage: false,
      models: [{ model: 'model-a', modelName: 'Model A', tokens: 1234, estimatedCostUsd: 0.125, hasUnpricedUsage: false }] };
    const html = render();
    for (const text of ['Model A', '1,234', 'USD', '0.125', en.tokenUsage.period, en.tokenUsage.total]) expect(html).toContain(text);
    expect(html).toContain('<table');
    expect(html).not.toContain('Cache read tokens');
    expect(html).not.toContain(en.tokenUsage.empty);
  });
  it("labels unknown and partial pricing rather than implying custom endpoints are free", () => {
    state.loading = false;
    state.data = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z', estimatedCostUsd: 0.01, hasUnpricedUsage: true,
      models: [
        { model: 'mixed', modelName: 'Mixed model', tokens: 100, estimatedCostUsd: 0.01, hasUnpricedUsage: true },
        { model: 'custom', modelName: 'Custom endpoint', tokens: 50, estimatedCostUsd: null, hasUnpricedUsage: true },
      ] };
    const html = render();
    for (const text of [en.tokenUsage.unavailable, en.tokenUsage.partial, en.tokenUsage.partialCost, en.tokenUsage.description]) expect(html).toContain(text);
  });
  it("distinguishes an empty period", () => {
    state.loading = false;
    state.data = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z', models: [], estimatedCostUsd: 0, hasUnpricedUsage: false };
    expect(render()).toContain(en.tokenUsage.empty);
  });
});


it("[COMP:app-web/token-usage] refreshes on click and focus, and removes the focus listener", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.refresh.mockClear();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><TokenUsageSection /></I18nProvider>));
    await act(async () => host.querySelector("button")!.click());
    expect(state.refresh).toHaveBeenCalledTimes(1);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(state.refresh).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
  window.dispatchEvent(new Event("focus"));
  expect(state.refresh).toHaveBeenCalledTimes(2);
});
