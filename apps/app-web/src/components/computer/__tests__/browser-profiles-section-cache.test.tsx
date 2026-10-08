// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache-tail] Computer -> Browser profiles paints from
 * the surface cache (instant-navigation contract N1 / N3 / N4).
 *
 * The two contracts every adopted surface holds: (a) a warmed key paints the
 * rows on the FIRST frame while the fetch is still in flight (no skeleton,
 * no sentence), and (b) a mark-stale (the spine's signal shape) repaints
 * behind the paint with no blank frame - the rows stay up while the
 * revalidation runs, then update. Before this the section rendered a bare
 * "..." for the whole round trip on every visit.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ listBrowserProfiles: vi.fn(), fetchBrowserProfileDestinations: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "ws-1" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => false) }));
vi.mock("../connect-browser-panel", () => ({
  ConnectBrowserPanel: () => <div data-testid="connect-panel" />,
}));
vi.mock("@/lib/api/computer", () => ({
  listBrowserProfiles: (...args: unknown[]) => api.listBrowserProfiles(...args),
  fetchBrowserProfileDestinations: (...args: unknown[]) => api.fetchBrowserProfileDestinations(...args),
  captureProfileSession: vi.fn(),
  classifyBrowserProfileDepartment: vi.fn(),
  createBrowserProfile: vi.fn(),
  deleteBrowserProfile: vi.fn(),
  revokeProfileGrant: vi.fn(),
  revokeBrowserCredential: vi.fn(),
  revokeProfileSession: vi.fn(),
  saveBrowserCredential: vi.fn(),
  startProfileLogin: vi.fn(),
  testBrowserCredential: vi.fn(),
  updateBrowserProfile: vi.fn(),
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en };
});

import type { BrowserProfile } from "@/lib/api/computer";
import { BrowserProfilesSection } from "../browser-profiles-section";
import { browserProfilesCacheKey } from "@/lib/surface-prefetch";
import { loadSurfaceCache, markSurfaceCacheStale, resetSurfaceCache, SurfaceCacheEvictionError } from "@/lib/surface-cache";

const KEY = browserProfilesCacheKey("ws-1");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function profile(overrides: Partial<BrowserProfile>): BrowserProfile {
  return {
    id: "profile-1",
    workspaceId: "ws-1",
    ownerUserId: "user-1",
    name: "Personal",
    scope: "owner",
    clearance: "confidential",
    enabledAssistantIds: [],
    canManage: false,
    defaultBackend: "cloud",
    localControlMode: "task_tabs",
    proxyUrl: null,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    sessions: [],
    credentials: [],
    grants: [],
    ...overrides,
  };
}

const roster = (profiles: BrowserProfile[]) => ({
  configured: true,
  credentialAuthConfigured: false,
  profiles,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(creating = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<BrowserProfilesSection creating={creating} />);
    await settle();
  });
}

const skeleton = () => container!.querySelector('[data-testid="browser-profiles-skeleton"]');

beforeEach(() => {
  resetSurfaceCache();
  api.listBrowserProfiles.mockReset();
  api.fetchBrowserProfileDestinations.mockReset().mockResolvedValue({ departments: [] });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe("[COMP:app-web/surface-cache-tail] Browser profiles from the surface cache", () => {
  it("retains creation controls during successful authority renewal and evicts them on failure", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    api.listBrowserProfiles.mockResolvedValue(roster([]));
    await mount(true);
    const control = container!.querySelector('[role="combobox"]');
    expect(control).not.toBeNull();
    await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
    expect(api.fetchBrowserProfileDestinations).toHaveBeenCalledTimes(2);
    expect(container!.querySelector('[role="combobox"]')).toBe(control);
    api.fetchBrowserProfileDestinations.mockRejectedValueOnce(new SurfaceCacheEvictionError(new Error("revoked")));
    await act(async () => { window.dispatchEvent(new Event("focus")); await settle(); });
    expect(container!.querySelector('[role="combobox"]')).toBeNull();
    const { en } = await import("@/lib/i18n/dictionaries/en");
    const create = [...container!.querySelectorAll("button")].find(button => button.textContent === en.computer.profiles.createAction);
    expect(create?.disabled).toBe(true);
  });

  it("paints a cold entry as the card skeleton, never a sentence", async () => {
    api.listBrowserProfiles.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(skeleton()).not.toBeNull();
    expect(container!.textContent).not.toContain("…");
    expect(container!.textContent).not.toContain("...");
  });

  it("first paint from a warmed key renders the profile while the fetch is still pending", async () => {
    await loadSurfaceCache(KEY, async () => roster([profile({ name: "Personal" })]));
    // Stale (the revisit-after-a-while case): the mount refetches, but the
    // rows are on screen from the first frame.
    markSurfaceCacheStale(KEY);
    api.listBrowserProfiles.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(api.listBrowserProfiles).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("Personal");
    expect(skeleton()).toBeNull();
  });

  it("a mark-stale repaints behind the paint: rows stay up, then update", async () => {
    await loadSurfaceCache(KEY, async () => roster([profile({ name: "Personal" })]));
    let release: (value: ReturnType<typeof roster>) => void = () => {};
    api.listBrowserProfiles.mockImplementation(
      () => new Promise<ReturnType<typeof roster>>((resolve) => { release = resolve; }),
    );
    await mount();
    expect(api.listBrowserProfiles).not.toHaveBeenCalled();

    await act(async () => {
      markSurfaceCacheStale("browser-profiles:ws-1");
      await settle();
    });
    expect(api.listBrowserProfiles).toHaveBeenCalledTimes(1);
    // Still painting the last good roster while the revalidation runs.
    expect(container!.textContent).toContain("Personal");
    expect(skeleton()).toBeNull();

    await act(async () => {
      release(roster([profile({ name: "Renamed" })]));
      await settle();
    });
    expect(container!.textContent).toContain("Renamed");
    expect([...container!.querySelectorAll("span")].some(node => node.textContent === "Personal")).toBe(false);
  });
});


describe("[COMP:app-web/profile-management] Shared reader controls", () => {
  it("removes the classification editor and clears its reason after failed directory renewal", async () => {
    api.listBrowserProfiles.mockResolvedValue(roster([profile({canManage:true})]));
    await mount();
    const {en}=await import("@/lib/i18n/dictionaries/en");
    const reasonInput=()=>[...container!.querySelectorAll("label")].find(label=>label.textContent?.includes(en.computer.profiles.classificationReason))?.querySelector("input");
    expect(reasonInput()).toBeTruthy();
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(reasonInput(),"Fictional protected draft");
      reasonInput()!.dispatchEvent(new Event("input",{bubbles:true}));
      await settle();
    });
    expect(reasonInput()!.value).toBe("Fictional protected draft");
    api.fetchBrowserProfileDestinations.mockRejectedValueOnce(new SurfaceCacheEvictionError(new Error("revoked")));
    await act(async()=>{window.dispatchEvent(new Event("focus"));await settle();});
    expect(reasonInput()).toBeUndefined();
    await act(async()=>{window.dispatchEvent(new Event("focus"));await settle();});
    expect(reasonInput()!.value).toBe("");
  });

  it("shows current owning department and clears its name after failed authority renewal", async () => {
    api.listBrowserProfiles.mockResolvedValue(roster([profile({name:"Shared identity",scope:"workspace",departmentId:"department-1",canManage:false})]));
    api.fetchBrowserProfileDestinations.mockResolvedValue({departments:[{id:"department-1",name:"Fictional research",clearance:"confidential"}]});
    await mount();
    const {en}=await import("@/lib/i18n/dictionaries/en");
    expect(container!.textContent).toContain("Fictional research");
    expect(container!.textContent).toContain(en.computer.profiles.departmentMembers);
    expect(container!.textContent).not.toContain(en.computer.profiles.scopeWorkspace);
    api.fetchBrowserProfileDestinations.mockRejectedValueOnce(new SurfaceCacheEvictionError(new Error("revoked")));
    await act(async()=>{window.dispatchEvent(new Event("focus"));await settle();});
    expect(container!.textContent).not.toContain("Fictional research");
    expect(container!.textContent).toContain(en.computer.profiles.departmentUnavailable);
    expect(container!.textContent).not.toContain("department-1");
  });

  it.each([false, undefined])("keeps readable metadata without owner commands when canManage is %s", async (canManage) => {
    api.listBrowserProfiles.mockResolvedValue(roster([profile({ name: "Shared identity", scope: "workspace", canManage,
      sessions: [{ site: "portal.example", capturedAt: "2026-10-06T00:00:00Z", lastUsedAt: null, status: "active" }],
      grants: [{ id: "grant-1", skillId: "skill-1", skillName: "Read portal", createdAt: "2026-10-06T00:00:00Z", lastUsedAt: null }] })]));
    await mount();
    const { en } = await import("@/lib/i18n/dictionaries/en");
    expect(container!.textContent).toContain("Shared identity");
    expect(container!.textContent).toContain("portal.example");
    expect(container!.textContent).toContain("Read portal");
    expect(container!.textContent).toContain(en.computer.profiles.scopeWorkspace);
    expect(container!.textContent).toContain(en.computer.profiles.clearanceConfidential);
    expect(container!.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container!.querySelector('button[aria-label="' + en.computer.profiles.deleteProfile + '"]')).toBeNull();
    for (const label of [en.computer.profiles.loginAction, en.computer.profiles.proxySave, en.computer.profiles.revoke]) {
      expect([...container!.querySelectorAll("button")].some(button => button.textContent === label)).toBe(false);
    }
  });
});
