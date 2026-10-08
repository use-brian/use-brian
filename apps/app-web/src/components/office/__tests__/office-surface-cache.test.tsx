// @vitest-environment jsdom
/**
 * [COMP:app-web/office-surface-cache] Office home + editor shell on the ONE
 * surface cache (instant-navigation contract N1 / N2 / N3 / N7).
 *
 * Pins the two behaviours every adopted surface owes: a warmed key paints on
 * the first frame with the fetch still pending (no skeleton, no sentence), and
 * a mark-stale repaints without a blank frame. Plus the editor's own claim:
 * its chrome paints from the home's list row before the snapshot resolves,
 * and the row + snapshot are two parallel keys, never a waterfall.
 */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ viewerId: "viewer-1", workspaceId: "11111111-1111-4111-8111-111111111111", search: "", pathname: "/office/templates/template-1", replace: vi.fn(), push: vi.fn() }));
const collab = vi.hoisted(() => ({ status: "disconnected", synced: false }));
const offlineApi = vi.hoisted(() => ({
  list: vi.fn(async () => [] as unknown[]), load: vi.fn(async () => null as unknown), remove: vi.fn(async () => undefined), quarantine: vi.fn(async () => undefined), classify: vi.fn(), materialize: vi.fn(),
}));
const api = vi.hoisted(() => ({
  listOfficeTemplates: vi.fn(),
  transitionOfficeTemplateLifecycle: vi.fn(),
  listOfficeArtifacts: vi.fn<() => Promise<unknown>>(),
  getOfficeArtifact: vi.fn<() => Promise<unknown>>(),
  getOfficeSnapshot: vi.fn<() => Promise<unknown>>(),
  getOfficeTemplateRouting: vi.fn(),
  saveOfficeTemplateRouting: vi.fn(),
  syncOfficeOfflineCommands: vi.fn(),
  transitionOfficeLifecycle: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn(), push: navigation.push, prefetch: vi.fn(), replace: navigation.replace }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: false, setSidebarCollapsed: vi.fn() }) }));
vi.mock("@/lib/workspace-context", () => ({useOptionalWorkspaceContext: () => ({workspaceId: navigation.workspaceId, me: {id: navigation.viewerId}})}));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: navigation.viewerId, name: "Viewer", email: "viewer@example.com" }) }));
vi.mock("@/lib/office/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/office/api")>();
  return {
    ...actual,
    getOfficeTemplateRouting: api.getOfficeTemplateRouting,
    saveOfficeTemplateRouting: api.saveOfficeTemplateRouting,
    listOfficeTemplates: (...args: unknown[]) => api.listOfficeTemplates(...args).then((value: object) => bounded(value)),
    transitionOfficeTemplateLifecycle: api.transitionOfficeTemplateLifecycle,
    listOfficeArtifacts: (...args: unknown[]) => api.listOfficeArtifacts(...(args as [])).then((value) => bounded(value as object)),
    getOfficeArtifact: (...args: unknown[]) => api.getOfficeArtifact(...(args as [])).then(value => bounded(value as object)),
    getOfficeSnapshot: (...args: unknown[]) => api.getOfficeSnapshot(...(args as [])).then(value => bounded(value as object)),
    listOfficeComments: vi.fn(async () => bounded([])),
    listOfficeSuggestions: vi.fn(async () => bounded([])),
    detachMissingOfficeComments: vi.fn(async () => 0),
    syncOfficeOfflineCommands: api.syncOfficeOfflineCommands,
    transitionOfficeLifecycle: api.transitionOfficeLifecycle,
  };
});
// The editor shell's heavy neighbours: collab, presence, the three editors,
// the recorder and the reclassify dialog are not what this test grades.
vi.mock("@/lib/collab/use-collab-provider", () => ({ useCollabProvider: () => ({ doc: null, provider: null, status: collab.status, synced: collab.synced }) }));
vi.mock("@/lib/collab/use-presence", () => ({ usePresence: () => [], usePublishPresenceActivity: vi.fn(), usePublishPresenceIdentity: vi.fn() }));
vi.mock("@/components/doc/presence-avatars", () => ({ PresenceAvatars: () => null }));
vi.mock("@/components/context/reclassify-context-dialog", () => ({ ReclassifyContextButton: () => <button type="button">Reclassify</button> }));
vi.mock("@/components/chrome/dock-recorder", () => ({ DockRecorderFallback: ({ className }: { className?: string }) => <div data-testid="recorder" className={className} /> }));
vi.mock("@/lib/chat-dock-suppress", () => ({ chatDockSuppression: { suppress: () => () => undefined } }));
vi.mock("../document-editor", () => ({ DocumentEditor: ({ snapshot }: { snapshot: { artifactId: string } }) => <div data-testid="document-editor" data-artifact={snapshot.artifactId} /> }));
vi.mock("../presentation-editor", () => ({ PresentationEditor: () => <div data-testid="presentation-editor" /> }));
vi.mock("../spreadsheet-editor", () => ({ SpreadsheetEditor: () => <div data-testid="spreadsheet-editor" /> }));
vi.mock("../presentation-presenter", () => ({ PresentationPresenter: () => null }));
vi.mock("../job-activity", () => ({ OfficeJobActivity: () => <div data-testid="job-activity" /> }));
vi.mock("../office-card-preview", () => ({ OfficeCardPreview: () => <div data-testid="card-preview" /> }));
vi.mock("@/lib/office/offline", () => ({
  appendOfflineCommand: vi.fn(), classifyOfficeReconnect: offlineApi.classify, listOfflineJournal: offlineApi.list,
  loadOfflinePackage: offlineApi.load, removeOfflineJournalEntry: offlineApi.remove, removeOfflinePackage: vi.fn(async () => undefined),
  materializeOfflineRecoverySnapshot: offlineApi.materialize, officeOfflineDeviceId: vi.fn(async () => "fixture-device"), quarantineOfflineWork: offlineApi.quarantine,
}));

import { loadOfflinePackage } from "@/lib/office/offline";
import { inheritOfficeMetadata, attachOfficeMetadata } from "@/lib/office/metadata";
const bounded = <T extends object>(value: T): T => attachOfficeMetadata(structuredClone(value), 30_000, performance.now(), "viewer-1");

import { OfficeTemplateLibrary } from "../template-library";
import { OfficeHome } from "../office-home";
import { OfficeEditorShell } from "../office-editor-shell";
import { invalidateSurfaceCache, mutateSurfaceCache, loadSurfaceCache, markSurfaceCacheStale, readSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { invalidateOfficeList, officeTemplateListCacheKey, officeArtifactCacheKey, officeListCacheKey, officeSnapshotCacheKey } from "@/lib/surface-prefetch";
import { officeArtifactFromListCache, useOfficeCacheRevalidation } from "@/lib/office/surface-cache";
import type { OfficeArtifact, OfficeLiveSnapshot } from "@/lib/office/api";
import type { OfficeTemplateRoutingDraft } from "@use-brian/office-model";
import { documentFixture, spreadsheetFixture } from "./editor-fixtures";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ARTIFACT = "22222222-2222-4222-8222-222222222222";
const ROW: OfficeArtifact = { artifactId: ARTIFACT, family: "document", title: "Quarterly plan", version: 3, lifecycleState: "active", role: "edit" };
const SNAPSHOT = { snapshot: { family: "document", artifactId: ARTIFACT, workspaceId: WORKSPACE, sections: [], resources: [] }, seq: 7, baseVersion: 3 };

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pending = () => new Promise<never>(() => undefined);

let container: HTMLDivElement;
let root: Root;
function render(node: React.ReactNode) {
  const outer = node as {props?: {workspaceId?: string; children?: {props?: {workspaceId?: string}}}};
  navigation.workspaceId = outer.props?.workspaceId ?? outer.props?.children?.props?.workspaceId ?? WORKSPACE;
  act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}>{node}</I18nProvider>));
}

beforeEach(() => {
  navigation.viewerId = "viewer-1";
  resetSurfaceCache();
  navigation.search = "";
  navigation.pathname = "/office/templates/template-1";
  navigation.replace.mockClear();
  navigation.push.mockClear();
  collab.status = "disconnected";
  collab.synced = false;
  offlineApi.list.mockReset().mockResolvedValue([]);
  offlineApi.load.mockReset().mockResolvedValue(null);
  offlineApi.remove.mockReset().mockResolvedValue(undefined);
  offlineApi.quarantine.mockReset().mockResolvedValue(undefined);
  offlineApi.classify.mockReset();
  offlineApi.materialize.mockReset();
  api.listOfficeArtifacts.mockReset();
  api.getOfficeArtifact.mockReset();
  api.getOfficeSnapshot.mockReset();
  api.getOfficeTemplateRouting.mockReset();
  api.saveOfficeTemplateRouting.mockReset();
  api.syncOfficeOfflineCommands.mockReset();
  api.transitionOfficeLifecycle.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[COMP:app-web/office-surface-cache] Office home", () => {
  it("paints the warmed list on the first frame while the fetch is still pending (N1)", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "active"), async () => bounded([ROW]));
    api.listOfficeArtifacts.mockImplementation(pending);
    render(<OfficeHome workspaceId={WORKSPACE} />);
    expect(container.querySelector('[data-office-file-grid="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Quarterly plan");
    expect(container.querySelector("[data-office-home-skeleton]")).toBeNull();
    expect(container.textContent).not.toContain(en.office.loading);
  });

  it("renders the card skeleton, never a sentence, when nothing is cached (N4)", () => {
    api.listOfficeArtifacts.mockImplementation(pending);
    render(<OfficeHome workspaceId={WORKSPACE} />);
    expect(container.querySelector("[data-office-home-skeleton]")).not.toBeNull();
    expect(container.textContent).not.toContain(en.office.loading);
  });

  it("repaints without a blank frame after markSurfaceCacheStale (N3)", async () => {
    const key = officeListCacheKey(WORKSPACE, "active");
    await loadSurfaceCache(key, async () => bounded([ROW]));
    let resolveNext: (rows: OfficeArtifact[]) => void = () => undefined;
    api.listOfficeArtifacts.mockImplementation(() => new Promise<OfficeArtifact[]>((resolve) => { resolveNext = resolve; }));
    render(<OfficeHome workspaceId={WORKSPACE} />);
    act(() => markSurfaceCacheStale(key));
    // Stale rows stay up while the refetch runs.
    expect(container.textContent).toContain("Quarterly plan");
    expect(container.querySelector("[data-office-home-skeleton]")).toBeNull();
    expect(readSurfaceCache(key).revalidating).toBe(true);
    await act(async () => { resolveNext([{ ...ROW, title: "Quarterly plan v2" }]); await settle(); });
    expect(container.textContent).toContain("Quarterly plan v2");
  });

  it("reads each lifecycle view from its own key", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "trash"), async () => bounded([{ ...ROW, title: "Old deck", lifecycleState: "trash" }]));
    api.listOfficeArtifacts.mockImplementation(pending);
    navigation.search = "view=trash";
    render(<OfficeHome workspaceId={WORKSPACE} />);
    expect(container.textContent).toContain("Old deck");
  });
});

describe("[COMP:app-web/office-surface-cache] Office editor shell", () => {
  it("paints the chrome from the home's list row before the snapshot resolves, and fetches row + snapshot in parallel (N7)", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "active"), async () => bounded([ROW]));
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Quarterly plan");
    expect(container.querySelector('[data-office-editor-skeleton="document"]')).not.toBeNull();
    expect(container.textContent).not.toContain(en.office.editorLoading);
    // Both requests left in the same tick: no artifact -> snapshot waterfall.
    expect(api.getOfficeArtifact).toHaveBeenCalledTimes(1);
    expect(api.getOfficeSnapshot).toHaveBeenCalledTimes(1);
  });

  it("paints the editor on the first frame from warmed row + snapshot keys (N1)", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT), async () => bounded(ROW));
    await loadSurfaceCache(officeSnapshotCacheKey(WORKSPACE, ARTIFACT), async () => bounded(SNAPSHOT));
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[data-office-shell-state="ready"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="document-editor"]')?.getAttribute("data-artifact")).toBe(ARTIFACT);
    expect(container.querySelector("[data-office-editor-skeleton]")).toBeNull();
  });

  it("keeps the editor up while a stale snapshot revalidates (N3)", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT), async () => bounded(ROW));
    await loadSurfaceCache(officeSnapshotCacheKey(WORKSPACE, ARTIFACT), async () => bounded(SNAPSHOT));
    api.getOfficeArtifact.mockImplementation(async () => bounded(ROW));
    let resolveSnapshot: (value: typeof SNAPSHOT) => void = () => undefined;
    api.getOfficeSnapshot.mockImplementation(() => new Promise<typeof SNAPSHOT>((resolve) => { resolveSnapshot = resolve; }));
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    act(() => markSurfaceCacheStale(officeSnapshotCacheKey(WORKSPACE, ARTIFACT)));
    expect(container.querySelector('[data-testid="document-editor"]')).not.toBeNull();
    expect(container.querySelector("[data-office-editor-skeleton]")).toBeNull();
    await act(async () => { resolveSnapshot({ ...SNAPSHOT, seq: 8 }); await settle(); });
    expect(container.querySelector('[data-testid="document-editor"]')).not.toBeNull();
  });

  it("renders the bare topbar over a skeleton when nothing is known (N4)", () => {
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[data-office-shell-state="loading"]')).not.toBeNull();
    expect(container.querySelector("[data-office-editor-skeleton]")).not.toBeNull();
    expect(container.textContent).not.toContain(en.office.editorLoading);
  });

  it("lifts the recorder pill above the phone toolbar only for a Document (report B row 15)", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT), async () => bounded(ROW));
    await loadSurfaceCache(officeSnapshotCacheKey(WORKSPACE, ARTIFACT), async () => bounded(SNAPSHOT));
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.querySelector('[data-testid="recorder"]')?.className).toContain("max-sm:bottom-20");
  });

  it("opens and discards the ordinary recovery artifact published for an offline conflict", async () => {
    await loadSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT), async () => bounded(ROW));
    await loadSurfaceCache(officeSnapshotCacheKey(WORKSPACE, ARTIFACT), async () => bounded(SNAPSHOT));
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    collab.status = "connected";
    collab.synced = true;
    const command = { artifactId: ARTIFACT, seq: 8, kind: "command", expectedSeq: 7, command: { artifactId: ARTIFACT, baseVersion: 3, actor: { type: "user", id: navigation.viewerId }, origin: "offline", commandId: "33333333-3333-4333-8333-333333333333", kind: "setObjectProperty", targetId: "44444444-4444-4444-8444-444444444444", path: ["alignment"], value: "center" }, createdAt: "2026-09-28T00:00:00.000Z" };
    offlineApi.list.mockResolvedValue([command]);
    offlineApi.load.mockResolvedValue({ payload: { snapshot: SNAPSHOT.snapshot } });
    offlineApi.materialize.mockReturnValue(SNAPSHOT.snapshot);
    offlineApi.classify.mockReturnValue({ status: "needs_attention", quarantine: false, conflict: true });
    api.syncOfficeOfflineCommands.mockResolvedValue({ status: "needs_attention", reason: "structural_conflict", recoveryArtifactId: "55555555-5555-4555-8555-555555555555" });
    api.transitionOfficeLifecycle.mockResolvedValue({});
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    await act(async () => { await settle(); await settle(); });
    expect(container.textContent).toContain(en.office.offlineNeedsAttention);
    const open = [...container.querySelectorAll("button")].find((node) => node.textContent === en.office.openRecoveryCopy)!;
    act(() => open.click());
    expect(navigation.push).toHaveBeenCalledWith(`/w/${WORKSPACE}/office/55555555-5555-4555-8555-555555555555`);
    const discard = [...container.querySelectorAll("button")].find((node) => node.textContent === en.office.discardRecoveryCopy)!;
    await act(async () => { discard.click(); await settle(); });
    expect(api.transitionOfficeLifecycle).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", "trash", "Discarded recovered offline copy");
    expect(offlineApi.remove).toHaveBeenCalledWith(command, { workspaceId: WORKSPACE, userId: navigation.viewerId });
  });
});

describe("[COMP:app-web/office-template-routing] live editor integration", () => {
  it.each([documentFixture, spreadsheetFixture])("keeps the real field editor alive while collapsed and gates publish on saved live bindings", async (fixture) => {
    const snapshot = fixture();
    if (snapshot.family === "document") snapshot.sections[0]!.header[0]!.text = "{{NAME}}";
    else snapshot.worksheets[0]!.cells[0]!.value = "{{NAME}}";
    let persisted: OfficeTemplateRoutingDraft = { source: "upload", fields: [], slideRecipes: [] };
    api.getOfficeTemplateRouting.mockImplementation(async () => bounded(persisted));
    api.saveOfficeTemplateRouting.mockImplementation(async (_id: string, value: OfficeTemplateRoutingDraft) => { persisted = structuredClone(value); return persisted; });
    navigation.search = "templateId=template-1";
    await loadSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT), async () => bounded({ ...ROW, family: snapshot.family, mode: "template" }));
    await loadSurfaceCache(officeSnapshotCacheKey(WORKSPACE, ARTIFACT), async () => bounded({ snapshot, seq: 0, baseVersion: 1 }));
    api.getOfficeArtifact.mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    await act(async () => { await settle(); });
    expect(container.querySelector('[data-template-routing="ready"]')).not.toBeNull();
    const publish = () => [...container.querySelectorAll("button")].find((node) => node.textContent === en.office.templateAdmit || node.textContent === en.office.routingSaveBeforePublish)!;
    const fieldInput = () => container.querySelector('[data-template-routing-field] input') as HTMLInputElement;
    expect(publish().disabled).toBe(true);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(fieldInput(), "Reviewed label");
      fieldInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (container.querySelector(`[aria-label="${en.office.collapseAssistantPanel}"]`) as HTMLButtonElement).click());
    expect(container.querySelector('[data-office-panel="collapsed"]')).not.toBeNull();
    expect(fieldInput().value).toBe("Reviewed label");
    expect(api.getOfficeTemplateRouting).toHaveBeenCalledTimes(1);
    await act(async () => (container.querySelector(`[aria-label="${en.office.expandAssistantPanel}"]`) as HTMLButtonElement).click());
    expect(fieldInput().value).toBe("Reviewed label");
    const save = () => [...container.querySelectorAll("button")].find((node) => node.textContent === en.office.routingSave)!;
    await act(async () => save().click());
    expect(persisted.fields[0]!.label).toBe("Reviewed label");
    expect(publish().disabled).toBe(false);
    await act(async () => (container.querySelector(`[aria-label="${en.office.collapseAssistantPanel}"]`) as HTMLButtonElement).click());
    const changed = structuredClone(snapshot);
    if (changed.family === "document") changed.sections[0]!.header[0]!.text = "{{RENAMED}}";
    else changed.worksheets[0]!.cells[0]!.value = "{{RENAMED}}";
    await act(async () => mutateSurfaceCache<OfficeLiveSnapshot>(officeSnapshotCacheKey(WORKSPACE, ARTIFACT), (previous) => inheritOfficeMetadata({ ...previous, snapshot: changed }, previous, "viewer-1")));
    expect(publish().disabled).toBe(true);
    await act(async () => (container.querySelector(`[aria-label="${en.office.expandAssistantPanel}"]`) as HTMLButtonElement).click());
    expect(container.textContent).toContain("{{RENAMED}}");
    await act(async () => save().click());
    expect(persisted.fields.map((field) => field.name)).toEqual(["RENAMED"]);
    expect(publish().disabled).toBe(false);
    expect(api.getOfficeTemplateRouting).toHaveBeenCalledTimes(3); // Initial read and two post-save readbacks.
    // A route remount reuses the bounded saved read, not inferred defaults.
    act(() => root.render(null));
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    await act(async () => { await settle(); });
    expect(publish().disabled).toBe(false);
    expect(api.getOfficeTemplateRouting).toHaveBeenCalledTimes(3);
  });
});

describe("[COMP:app-web/office-surface-cache] helpers", () => {
  it("finds the artifact row in whichever view's cached list carries it", async () => {
    expect(officeArtifactFromListCache(WORKSPACE, ARTIFACT)).toBeNull();
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "archived"), async () => bounded([{ ...ROW, lifecycleState: "archived" }]));
    expect(officeArtifactFromListCache(WORKSPACE, ARTIFACT)?.lifecycleState).toBe("archived");
    expect(officeArtifactFromListCache("other", ARTIFACT)).toBeNull();
  });

  it("invalidateOfficeList drops every view of one workspace and nothing else", async () => {
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "active"), async () => bounded(["a"]));
    await loadSurfaceCache(officeListCacheKey(WORKSPACE, "trash"), async () => bounded(["t"]));
    await loadSurfaceCache(officeListCacheKey("other", "active"), async () => bounded(["other"]));
    invalidateOfficeList(WORKSPACE);
    expect(readSurfaceCache(officeListCacheKey(WORKSPACE, "active")).data).toBeUndefined();
    expect(readSurfaceCache(officeListCacheKey(WORKSPACE, "trash")).data).toBeUndefined();
    expect(readSurfaceCache(officeListCacheKey("other", "active")).data).toEqual(["other"]);
    invalidateSurfaceCache("office:");
  });

  it("marks the given prefixes stale when the tab comes back to the foreground, keeping the rows", async () => {
    const key = officeListCacheKey(WORKSPACE, "active");
    await loadSurfaceCache(key, async () => bounded([ROW]));
    function Probe() { useOfficeCacheRevalidation([`office:${WORKSPACE}:`]); return null; }
    render(<Probe />);
    expect(readSurfaceCache(key).updatedAt).toBeGreaterThan(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(readSurfaceCache(key).updatedAt).toBe(0);
    expect(readSurfaceCache(key).data).toEqual([ROW]);
  });
});


describe("[COMP:app-web/office-surface-cache] template lifecycle", () => {
  const template = { id: "template-1", name: "Sample template", family: "document", description: "Example", lifecycleState: "draft", draftArtifactId: ARTIFACT, currentVersionId: null };
  const button = (label: string) => Array.from(document.querySelectorAll("button")).find((node) => node.textContent === label)!;
  beforeEach(() => {
    api.listOfficeTemplates.mockReset().mockResolvedValue([template]);
    api.transitionOfficeTemplateLifecycle.mockReset();
  });

  it("opens template details in a labelled dialog and closes back to the library without mutation", async () => {
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain(template.name);
    expect(container.querySelector("main h1")?.textContent).toBe(en.office.templateTitle);
    expect(container.querySelector("main [role=dialog]")).toBeNull();
    expect(container.querySelector("[data-office-template-card]")).not.toBeNull();
    await act(async () => { (dialog.querySelector(`button[aria-label="${en.office.closeTemplateAria}"]`) as HTMLButtonElement).click(); });
    expect(navigation.replace).toHaveBeenCalledWith(`/w/${WORKSPACE}/office/templates`, { scroll: false });
    expect(api.transitionOfficeTemplateLifecycle).not.toHaveBeenCalled();
  });

  it("opens failed-import recovery without navigating away and losing its state", async () => {
    api.listOfficeTemplates.mockResolvedValue([{...template,importState:{jobId:"failed-job",status:"failed",fileId:"source-file",diagnostics:[]}}]);
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    await act(async () => { button(en.office.retryTemplateImport).click(); });
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(en.office.uploadTemplateTitle);
    expect([...document.querySelectorAll('input')].some(input => input.value === template.name)).toBe(true);
  });

  it("refreshes Trash controls and removes a permanently deleted card without remounting", async () => {
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    api.transitionOfficeTemplateLifecycle.mockResolvedValue({ ...template, lifecycleState: "trash" });
    api.listOfficeTemplates.mockResolvedValue([{ ...template, lifecycleState: "trash" }]);
    await act(async () => { button(en.office.moveToTrash).click(); await settle(); });
    expect(button(en.office.moveToTrash)).toBeUndefined();
    expect(button(en.office.restore)).toBeDefined();
    const input = document.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, template.name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    api.listOfficeTemplates.mockResolvedValue([]);
    await act(async () => { button(en.office.deletePermanently).click(); await settle(); });
    expect(document.querySelector("[data-office-template-card]")).toBeNull();
    expect(document.body.textContent).toContain(en.office.noTemplates);
    expect(navigation.replace).toHaveBeenCalledWith(`/w/${WORKSPACE}/office/templates`);
  });

  it("invalidates every Files view and the linked draft caches after a successful lifecycle action", async () => {
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    const keys = [
      ...(["active", "archived", "trash", "retained"] as const).map(view => officeListCacheKey(WORKSPACE, view)),
      officeArtifactCacheKey(WORKSPACE, ARTIFACT), officeSnapshotCacheKey(WORKSPACE, ARTIFACT),
    ];
    await act(async () => { for (const key of keys) await loadSurfaceCache(key, async () => bounded([ROW])); });
    api.transitionOfficeTemplateLifecycle.mockResolvedValue({ ...template, lifecycleState: "trash" });
    api.listOfficeTemplates.mockResolvedValue([{ ...template, lifecycleState: "trash" }]);
    await act(async () => { button(en.office.moveToTrash).click(); await settle(); });
    for (const key of keys) expect(readSurfaceCache(key).data).toBeUndefined();
  });

  it("disables duplicate actions while pending and retains the row on rejection", async () => {
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    let reject!: (error: Error) => void;
    api.transitionOfficeTemplateLifecycle.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    act(() => { button(en.office.moveToTrash).click(); button(en.office.moveToTrash).click(); });
    expect(button(en.office.moveToTrash).disabled).toBe(true);
    expect(api.transitionOfficeTemplateLifecycle).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error("blocked")); await settle(); });
    expect(document.querySelector("[role=alert]")?.textContent).toBe(en.office.lifecycleFailed);
    expect(document.querySelector("[data-office-template-card]")).not.toBeNull();
    expect(button(en.office.moveToTrash).disabled).toBe(false);
  });

  it("revalidates foreground changes and restores a trashed template", async () => {
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    api.listOfficeTemplates.mockResolvedValue([{ ...template, lifecycleState: "trash" }]);
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); });
    expect(button(en.office.restore)).toBeDefined();
    api.transitionOfficeTemplateLifecycle.mockResolvedValue(template);
    api.listOfficeTemplates.mockResolvedValue([template]);
    await act(async () => { button(en.office.restore).click(); await settle(); });
    expect(button(en.office.moveToTrash)).toBeDefined();
    expect(button(en.office.restore)).toBeUndefined();
  });

  it.each(["unmount", "pathname", "search", "workspace", "template", "return"])("late purge after %s invalidates the original cache without navigating", async (change) => {
    api.listOfficeTemplates.mockResolvedValue([{ ...template, lifecycleState: "trash" }]);
    render(<StrictMode><OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} /></StrictMode>);
    await act(async () => { await settle(); });
    let complete!: (row: unknown) => void;
    api.transitionOfficeTemplateLifecycle.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const input = document.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, template.name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { button(en.office.deletePermanently).click(); });
    expect(api.transitionOfficeTemplateLifecycle).toHaveBeenCalledTimes(1);
    if (change === "unmount") render(<div>Other surface</div>);
    else {
      if (change === "pathname" || change === "return") navigation.pathname = "/other";
      if (change === "search") navigation.search = "intent=use";
      render(<StrictMode><OfficeTemplateLibrary
        workspaceId={change === "workspace" ? "other-workspace" : WORKSPACE}
        templateId={change === "template" ? "other-template" : template.id}
      /></StrictMode>);
    }
    await act(async () => { await settle(); });
    if (change === "return") {
      navigation.pathname = "/office/templates/template-1";
      render(<StrictMode><OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} /></StrictMode>);
    }
    if (change === "workspace") expect(readSurfaceCache(officeTemplateListCacheKey(WORKSPACE)).data).toBeUndefined();
    else expect(readSurfaceCache(officeTemplateListCacheKey(WORKSPACE)).data).toBeDefined();
    api.listOfficeTemplates.mockResolvedValue([]);
    await act(async () => { complete({}); await settle(); });
    expect(navigation.replace).not.toHaveBeenCalled();
    // Unmounted keys are dropped; still-mounted keys refetch the new empty list.
    expect(readSurfaceCache(officeTemplateListCacheKey(WORKSPACE)).data ?? []).toEqual([]);
  });

  it("an old failure cannot overwrite a new route's pending mutation", async () => {
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    let rejectOld!: (error: Error) => void;
    api.transitionOfficeTemplateLifecycle.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    act(() => { button(en.office.moveToTrash).click(); });
    const next = { ...template, id: "other-template" };
    api.listOfficeTemplates.mockResolvedValue([next]);
    render(<OfficeTemplateLibrary workspaceId="other-workspace" templateId={next.id} />);
    await act(async () => { await settle(); });
    api.transitionOfficeTemplateLifecycle.mockImplementation(pending);
    act(() => { button(en.office.moveToTrash).click(); });
    expect(api.transitionOfficeTemplateLifecycle).toHaveBeenCalledTimes(2);
    await act(async () => { rejectOld(new Error("old failure")); await settle(); });
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(button(en.office.moveToTrash).disabled).toBe(true);
  });

  it.each(["initial", "post-mutation"])("recovers from a %s list failure using Retry without remounting", async (phase) => {
    if (phase === "initial") api.listOfficeTemplates.mockRejectedValue(new Error("offline"));
    render(<OfficeTemplateLibrary workspaceId={WORKSPACE} templateId={template.id} />);
    await act(async () => { await settle(); });
    if (phase === "post-mutation") {
      api.transitionOfficeTemplateLifecycle.mockResolvedValue({});
      api.listOfficeTemplates.mockRejectedValue(new Error("offline"));
      await act(async () => { button(en.office.moveToTrash).click(); await settle(); });
    }
    expect(document.querySelector("[role=alert]")?.textContent).toBe(en.office.loadFailed);
    let complete!: (rows: unknown[]) => void;
    api.listOfficeTemplates.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    act(() => { button(en.chat.retry).click(); });
    expect(button(en.chat.retry).disabled).toBe(true);
    await act(async () => { complete([{ ...template, lifecycleState: "trash" }]); await settle(); });
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(button(en.chat.retry)).toBeUndefined();
    expect(button(en.office.restore)).toBeDefined();
    expect(document.querySelector("[data-office-template-card]")).not.toBeNull();
  });

  it("an obsolete request cannot clear the replacement's in-flight lock", async () => {
    const key = "office-templates:race:viewer";
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (rows: string[]) => void;
    const old = loadSurfaceCache(key, () => new Promise<string[]>((_, reject) => { rejectOld = reject; }));
    invalidateSurfaceCache(key);
    const replacement = loadSurfaceCache(key, () => new Promise<string[]>((resolve) => { resolveNew = resolve; }));
    rejectOld(new Error("obsolete"));
    await old;
    expect(readSurfaceCache(key).error).toBeUndefined();
    expect(loadSurfaceCache(key, async () => ["unexpected"])).toBe(replacement);
    resolveNew([]);
    await replacement;
    expect(readSurfaceCache(key).data).toEqual([]);
  });

  it("discards a pre-mutation read even if it finishes after the replacement request", async () => {
    const key = "office-templates:race:viewer";
    let resolveOld!: (rows: string[]) => void;
    const old = loadSurfaceCache(key, () => new Promise<string[]>((resolve) => { resolveOld = resolve; }));
    invalidateSurfaceCache(key);
    await loadSurfaceCache(key, async () => []);
    resolveOld(["deleted"]);
    await old;
    expect(readSurfaceCache(key).data).toEqual([]);
  });
});


describe("[COMP:app-web/office-surface-cache] editor ownership", () => {
  it("drops the prior viewer's warmed artifact and snapshot on an account switch", async () => {
    const oldArtifactKey = officeArtifactCacheKey(WORKSPACE, ARTIFACT, "viewer-1");
    const oldSnapshotKey = officeSnapshotCacheKey(WORKSPACE, ARTIFACT, "viewer-1");
    await loadSurfaceCache(oldArtifactKey, async () => bounded(ROW));
    await loadSurfaceCache(oldSnapshotKey, async () => bounded(SNAPSHOT));
    api.getOfficeArtifact.mockImplementation(pending); api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.textContent).toContain(ROW.title);
    navigation.viewerId = "viewer-2";
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    expect(container.textContent).not.toContain(ROW.title);
    expect(container.querySelector('[data-testid="document-editor"]')).toBeNull();
    expect(readSurfaceCache(oldArtifactKey).data).toBeUndefined();
    expect(readSurfaceCache(oldSnapshotKey).data).toBeUndefined();
    expect(loadOfflinePackage).toHaveBeenLastCalledWith(ARTIFACT, {workspaceId: WORKSPACE, userId: "viewer-2"});
  });

  it("cannot adopt a previous viewer's pending artifact read after remount", async () => {
    let resolveOld!: (row: OfficeArtifact) => void;
    api.getOfficeArtifact.mockImplementationOnce(() => new Promise(resolve => {resolveOld = resolve;})).mockImplementation(pending);
    api.getOfficeSnapshot.mockImplementation(pending);
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    navigation.viewerId = "viewer-2";
    render(<OfficeEditorShell workspaceId={WORKSPACE} artifactId={ARTIFACT} />);
    await act(async () => {resolveOld(ROW); await settle();});
    expect(container.textContent).not.toContain(ROW.title);
    expect(readSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT, "viewer-1")).data).toBeUndefined();
    expect(readSurfaceCache(officeArtifactCacheKey(WORKSPACE, ARTIFACT, "viewer-2")).data).toBeUndefined();
  });
});
