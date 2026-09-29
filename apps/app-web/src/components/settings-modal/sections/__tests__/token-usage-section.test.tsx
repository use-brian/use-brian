// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { TokenUsageSection } from "../token-usage-section";

const state = vi.hoisted(() => ({ data: undefined as unknown, error: undefined as unknown, loading: true, revalidating: false, refresh: vi.fn() }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "ws1" }) }));
vi.mock("@/lib/surface-cache", () => ({ useCachedResource: () => state, SurfaceCacheEvictionError: Error }));
vi.mock("@/lib/surface-prefetch", () => ({ tokenUsageCacheKey: (id: string) => `usage:${id}` }));
const render = () => renderToString(<I18nProvider locale="en" dict={en}><TokenUsageSection /></I18nProvider>);

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
  it("shows all recorded counters and the reporting window", () => {
    state.error = undefined;
    state.data = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z', inputTokens: 1234, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 };
    const html = render();
    for (const text of ['1,234', '50', '20', '5', en.tokenUsage.period, en.tokenUsage.cacheWriteTokens]) expect(html).toContain(text);
    expect(html).not.toContain(en.tokenUsage.empty);
  });
  it("distinguishes an empty period", () => {
    state.data = { from: '2026-08-01T00:00:00Z', to: '2026-08-31T00:00:00Z', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
