// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache-tail] Settings -> Models paints from the
 * surface cache (instant-navigation contract N1 / N3 / N4) - the
 * representative for the Settings sections (Plan & usage, the three provider
 * blocks and Domains adopt the same shape).
 *
 * (a) A warmed `settings-models:<wid>:<viewer>` key paints the routing cards
 * on the FIRST frame while the menu fetch is still pending - no skeleton, no
 * "Loading..." sentence. (b) A mark-stale keeps the cards up while the
 * revalidation runs, then updates.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { fetchModelMenu, getCustomLlmConfiguration } = vi.hoisted(() => ({
  fetchModelMenu: vi.fn(),
  getCustomLlmConfiguration: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceId: "ws-1" }) }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: "ws-1" }) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => false) }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: vi.fn(async () => null) }));
vi.mock("@/lib/api/models", () => ({
  clearWorkspaceModelDefault: vi.fn(),
  clearWorkspaceModelRoute: vi.fn(),
  createMeteredProfile: vi.fn(),
  deleteMeteredProfile: vi.fn(),
  fetchMeteredEstimate: vi.fn(),
  fetchModelMenu,
  setWorkspaceModelDefault: vi.fn(),
  setWorkspaceDecisionRouting: vi.fn(),
  setWorkspaceModelRoute: vi.fn(),
  updateMeteredProfile: vi.fn(),
}));
vi.mock("@/lib/api/custom-llm-endpoints", () => ({
  clearCustomLlmTierDefault: vi.fn(),
  createCustomLlmProfile: vi.fn(),
  deleteCustomLlmProfile: vi.fn(),
  getCustomLlmConfiguration,
  setCustomLlmTierDefault: vi.fn(),
  updateCustomLlmProfile: vi.fn(),
}));
vi.mock("../custom-llm-endpoints-block", () => ({
  CustomLlmEndpointsBlock: () => <div data-testid="endpoint-block" />,
}));
vi.mock("../llm-key-block", () => ({
  WorkspaceLlmKeyBlock: () => <div data-testid="llm-key-block" />,
}));
vi.mock("../codex-provider-card", () => ({
  CodexProviderCard: () => <div data-testid="codex-card" />,
}));

import { I18nProvider } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { en } from "@/lib/i18n/dictionaries/en";
import { ModelsSection } from "../models-section";
import { settingsModelsCacheKey } from "@/lib/surface-prefetch";
import { loadSurfaceCache, markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";

const tm = en.chrome.settingsModal.models;
const KEY = settingsModelsCacheKey("ws-1");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const profile = {
  id: "profile-1",
  endpointId: "endpoint-1",
  workspaceId: "ws-1",
  selector: "custom:profile-1",
  name: "terra-high",
  modelId: "terra-high",
  contextWindow: 32768,
  maxOutputTokens: 4096,
  supportsTools: true,
  supportsVision: false,
  verifiedAt: "2026-08-12T00:00:00.000Z",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};
const endpoint = (name: string) => ({
  id: "endpoint-1",
  workspaceId: "ws-1",
  name,
  baseUrl: "https://models.example/v1",
  hasApiKey: true,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  profiles: [profile],
});
const menu = {
  classes: {},
  defaults: [],
  profiles: [],
  modelRoutes: [],
  decisionRouting: {
    mode: "llm_only",
    modelAlias: null,
    updatedAt: null,
    shadowSampleRate: 0.1,
    models: [],
  },
  meteredBillingAvailable: false,
};
const bundle = (endpointName: string) => ({
  menu,
  custom: { endpoints: [endpoint(endpointName)], tierDefaults: [] },
  estimates: {},
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en as unknown as Dictionary}>
        <ModelsSection />
      </I18nProvider>,
    );
    await settle();
  });
}

async function openProviders() {
  await act(async () => {
    const tab = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent === tm.viewProviders,
    );
    tab?.click();
    await settle();
  });
}

const skeleton = () => container!.querySelector('[data-testid="models-skeleton"]');

beforeEach(() => {
  resetSurfaceCache();
  vi.clearAllMocks();
  getCustomLlmConfiguration.mockResolvedValue({ endpoints: [], tierDefaults: [] });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/surface-cache-tail] Models section from the surface cache", () => {
  it("paints a cold open as the routing-card skeleton, never the loading sentence", async () => {
    fetchModelMenu.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(skeleton()).not.toBeNull();
    expect(container!.textContent).not.toContain(tm.loading);
  });

  it("first paint from a warmed key renders the routing cards and the custom profile while the menu fetch is pending", async () => {
    await loadSurfaceCache(KEY, async () => bundle("hinson-pro"));
    markSurfaceCacheStale(KEY);
    fetchModelMenu.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(fetchModelMenu).toHaveBeenCalledTimes(1);
    expect(skeleton()).toBeNull();
    expect(container!.textContent).toContain(tm.customRoutingTitle);
    expect(container!.textContent).toContain(tm.classStandard);
    await openProviders();
    expect(skeleton()).toBeNull();
    expect(container!.textContent).toContain("hinson-pro / terra-high");
  });

  it("a mark-stale keeps the section painted while the revalidation runs, then updates", async () => {
    await loadSurfaceCache(KEY, async () => bundle("hinson-pro"));
    let release: (value: typeof menu) => void = () => {};
    fetchModelMenu.mockImplementation(() => new Promise<typeof menu>((resolve) => { release = resolve; }));
    getCustomLlmConfiguration.mockResolvedValue({ endpoints: [endpoint("renamed-endpoint")], tierDefaults: [] });
    await mount();
    await openProviders();
    expect(fetchModelMenu).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("hinson-pro / terra-high");

    await act(async () => {
      markSurfaceCacheStale("settings-models:ws-1");
      await settle();
    });
    expect(fetchModelMenu).toHaveBeenCalledTimes(1);
    expect(skeleton()).toBeNull();
    expect(container!.textContent).toContain("hinson-pro / terra-high");

    await act(async () => {
      release(menu);
      await settle();
      await settle();
    });
    expect(container!.textContent).toContain("renamed-endpoint / terra-high");
  });
});
