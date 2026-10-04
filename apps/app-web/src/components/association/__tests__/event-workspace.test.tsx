// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ module: vi.fn(), list: vi.fn(), read: vi.fn(), media: vi.fn(), save: vi.fn(), publish: vi.fn(), event: vi.fn(), confirm: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/api/association", async original => ({ ...await original<typeof import("@/lib/api/association")>(), getAssociationModuleSnapshot: api.module, listAssociationPage: api.list, getSiteContentDraft: api.read, listWebsiteMedia: api.media, saveSiteContentDraft: api.save, publishSiteContent: api.publish, saveAssociationEvent: api.event, uploadWebsiteMedia: api.upload }));
vi.mock("@/lib/surface-prefetch", () => ({ associationModuleCacheKey: (w: string) => `association-module:${w}:viewer`, associationPageCacheKey: (w: string, r: string, q = {}) => `crm:${w}:viewer:${r}:${JSON.stringify(q)}`, associationIntentKey: () => "fixture" }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirm }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
import { AssociationEventsPanel } from "../events-panel";
import { EventPageEditor } from "../events/event-page-editor";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { resetSurfaceCache } from "@/lib/surface-cache";
import type { AssociationEvent } from "@/lib/api/association";
const e = en.associationPage.eventPage, u = en.associationPage.ux, m = en.associationPage.manage;
const event: AssociationEvent = { id: "event-one", slug: "community-workshop", title: "Community workshop", description: "Meet the community", startsAt: "2027-01-05T12:00:00Z", endsAt: "2027-01-05T14:00:00Z", timezone: "UTC", mode: "venue", venue: "Community hall", onlineUrl: null, registrationOpensAt: null, registrationClosesAt: null, capacity: 20, status: "published", canonicalUrl: null, programmeKey: null, metadata: {} };
const savedPage = { event: event.slug, summary: { en: "Saved draft" }, sections: [] };
const publishedPage = { event: event.slug, summary: { en: "Published copy" }, sections: [] };
let host: HTMLDivElement, root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function render(node: ReactNode) { await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>)); }
async function click(text: string) { const button = [...host.querySelectorAll("button")].find(b => b.textContent === text); expect(button, text).toBeDefined(); await act(async () => button!.click()); }
async function type(label: string, value: string) { const input = [...host.querySelectorAll("label")].find(l => l.firstChild?.textContent === label)!.querySelector("input,textarea")!; await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(() => {
  resetSurfaceCache(); vi.resetAllMocks(); api.confirm.mockResolvedValue(true);
  api.module.mockResolvedValue({ canManage: true, module: { state: "enabled", version: 1 } });
  api.list.mockImplementation(async (_w, resource) => ({ items: resource === "events" ? [event] : [], nextCursor: null }));
  api.read.mockImplementation(async (_w, collection) => collection === "settings" ? { published: { sites: { community: { websiteUrl: "https://preview.example", name: { en: "Community website" } } } } } : { collection: "event-pages", version: 2, publishedRevision: 1, document: { schemaVersion: 1, pages: [savedPage] }, published: { schemaVersion: 1, pages: [publishedPage] }, readers: ["community"], issues: [], issueDetails: [] });
  api.media.mockResolvedValue([]); api.save.mockResolvedValue({ version: 3 }); api.publish.mockResolvedValue({ revision: 2 }); api.event.mockResolvedValue({ record: { ...event, status: "draft" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetSurfaceCache(); vi.useRealTimers(); });
describe("[COMP:app-web/association] Event website workspace", () => {
  it("requests website visibility before pagination and labels saved page changes", async () => {
    await render(<AssociationEventsPanel workspaceId="w" />);
    expect(api.list).toHaveBeenCalledWith("w", "events", expect.objectContaining({ website: "visible" }));
    expect(host.textContent).toContain(e.pageChanges);
    await click(u.drafts); expect(api.list).toHaveBeenLastCalledWith("w", "events", expect.objectContaining({ website: "drafts" }));
    await click(e.allEvents); expect(api.list).toHaveBeenLastCalledWith("w", "events", { cursor: undefined });
  });
  it("creates a hidden event and opens its workspace directly", async () => {
    await render(<AssociationEventsPanel workspaceId="w" initialNew />);
    await type(u.title, "New community workshop"); await type(m.start, "2027-01-05T12:00");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(api.event).toHaveBeenCalledWith("w", expect.objectContaining({ status: "draft", title: "New community workshop" }));
    expect(host.querySelector("[data-event-detail]")).toBeTruthy();
    expect(host.textContent).toContain(e.nameDetails); expect(host.textContent).toContain(e.feesTitle);
  });
  it("keeps create and page-draft controls out of a member's view", async () => {
    api.module.mockResolvedValue({ canManage: false, module: { state: "enabled" } });
    await render(<AssociationEventsPanel workspaceId="w" />);
    expect(host.textContent).not.toContain(m.newEvent); expect(api.read).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith(event.title))!.click());
    expect(host.textContent).not.toContain(m.newTicket); expect(host.textContent).not.toContain(e.moreActions);
  });
  it("reports unavailable page status without presenting it as published", async () => {
    api.read.mockRejectedValue(new Error("offline")); await render(<AssociationEventsPanel workspaceId="w" />);
    expect(host.textContent).toContain(e.statusUnavailable); expect(host.textContent).not.toContain(e.pageChanges);
  });
  it("saves an unsaved page to Brian without publishing it and preserves it across preview modes", async () => {
    await render(<EventPageEditor workspaceId="w" event={event} />);
    await type(e.summary, "Unpublished edit"); await click(e.openPreview); await click(e.backEditor);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Unpublished edit");
    await click(en.associationPage.content.save);
    expect(api.save).toHaveBeenCalledWith("w", "event-pages", 2, expect.objectContaining({ pages: [expect.objectContaining({ summary: { en: "Unpublished edit" } })] }));
    expect(api.publish).not.toHaveBeenCalled();
  });
  it("uploads a cover in place and saves its library reference in the page draft", async () => {
    api.upload.mockResolvedValue([{ media: { id: "cover-one", name: "Cover" } }]);
    await render(<EventPageEditor workspaceId="w" event={event} />);
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["synthetic image"], "cover.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(api.upload).toHaveBeenCalledWith("w", [file]);
    await click(en.associationPage.content.save);
    expect(api.save).toHaveBeenCalledWith("w", "event-pages", 2, expect.objectContaining({ pages: [expect.objectContaining({ cover: { mediaId: "cover-one", alt: { en: "cover" } } })] }));
    expect(api.publish).not.toHaveBeenCalled();
  });
  it("keeps unsaved page changes when staff decline to leave the editor", async () => {
    api.confirm.mockResolvedValue(false);
    await render(<AssociationEventsPanel workspaceId="w" initialEventId={event.id} />);
    await type(e.summary, "Keep this draft"); await click(u.guests);
    expect(api.confirm).toHaveBeenCalled(); expect(host.querySelector("[data-event-page-editor]")).toBeTruthy();
    expect((host.querySelector("[data-event-page-editor] textarea") as HTMLTextAreaElement).value).toBe("Keep this draft");
  });
  it("guards unsaved name edits and blocks publication until they are saved", async () => {
    api.confirm.mockResolvedValue(false);
    await render(<AssociationEventsPanel workspaceId="w" initialEventId={event.id} />);
    await type(u.title, "Keep this new name"); await click(u.guests);
    expect(api.confirm).toHaveBeenCalled(); expect(host.querySelector("[data-event-detail]")).toBeTruthy();
    expect([...host.querySelectorAll("button")].find(b => b.textContent === e.publishPage)?.disabled).toBe(true);
    expect(host.textContent).toContain(e.finishDetails);
  });
  it("hides an event through its canonical status while preserving its identity and history", async () => {
    await render(<AssociationEventsPanel workspaceId="w" initialEventId={event.id} />); await click(e.moreActions);
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === e.removeWebsite)!;
    await act(async () => remove.click());
    expect(api.event).toHaveBeenCalledWith("w", expect.objectContaining({ slug: event.slug, status: "draft", metadata: event.metadata }));
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it("publishes page content before exposing a hidden event", async () => {
    const expose = vi.fn(async () => true);
    await render(<EventPageEditor workspaceId="w" event={{ ...event, status: "draft" }} onPublishEvent={expose} />);
    await click(e.publishEvent); expect(api.publish).toHaveBeenCalledWith("w", "event-pages", 2); expect(expose).toHaveBeenCalledOnce();
    expect(api.publish.mock.invocationCallOrder[0]).toBeLessThan(expose.mock.invocationCallOrder[0]);
  });
  it("leaves the event hidden when page publication fails", async () => {
    api.publish.mockRejectedValue(new Error("conflict")); const expose = vi.fn();
    await render(<EventPageEditor workspaceId="w" event={{ ...event, status: "draft" }} onPublishEvent={expose} />);
    await click(e.publishEvent); expect(expose).not.toHaveBeenCalled(); expect(host.textContent).toContain(m.failed);
  });
  it("blocks publishing with unsaved edits, publication issues or failed refresh", async () => {
    await render(<EventPageEditor workspaceId="w" event={event} />); await type(e.summary, "Still typing");
    expect([...host.querySelectorAll("button")].some(b => b.textContent === e.publishPage)).toBe(false);
    await render(null); resetSurfaceCache(); api.read.mockResolvedValue({ version: 2, document: { pages: [savedPage] }, published: { pages: [publishedPage] }, readers: [], issues: ["Missing media"], issueDetails: [] });
    await render(<EventPageEditor workspaceId="w" event={event} />);
    expect([...host.querySelectorAll("button")].find(b => b.textContent === e.publishPage)?.disabled).toBe(true);
  });
  it("accepts ready messages only from the preview frame and compares draft with published content", async () => {
    vi.useFakeTimers(); await render(<EventPageEditor workspaceId="w" event={event} />);
    const frame = host.querySelector("iframe")!, send = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "https://preview.example", source: window, data: { type: "brian:event-preview:ready" } })); await vi.advanceTimersByTimeAsync(150); });
    expect(send).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "https://preview.example", source: frame.contentWindow, data: { type: "brian:event-preview:ready" } })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ page: savedPage }), "https://preview.example");
    await click(e.publishedVersion); await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ page: publishedPage }), "https://preview.example");
  });
  it("maps content to website locations and previews the selected section without saving selection", async () => {
    const defaultRead = api.read.getMockImplementation()!;
    api.read.mockImplementation(async (workspace, collection) => {
      const result = await defaultRead(workspace, collection);
      return collection !== "event-pages" ? result : { ...result, document: { schemaVersion: 1, pages: [{ ...savedPage, sections: [{ id: "text-one", kind: "text", heading: { en: "What to expect" }, body: { en: "Workshop details" } }] }] } };
    });
    vi.useFakeTimers(); await render(<EventPageEditor workspaceId="w" event={event} />);
    expect(host.textContent).toContain(`Community website / Events / ${event.title}`);
    expect(host.querySelector("[data-event-placement]")?.textContent).toContain(e.cardLocation);
    expect(host.querySelector("[data-event-placement]")?.textContent).toContain(e.introLocation);
    const row = host.querySelector('[data-section-card="text-one"]')!;
    expect(row.textContent).toContain(e.sectionPosition.replace("{number}", "1"));
    const frame = host.querySelector("iframe")!, send = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => window.dispatchEvent(new MessageEvent("message", { origin: "https://preview.example", source: frame.contentWindow, data: { type: "brian:event-preview:ready" } })));
    await act(async () => row.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ focus: expect.objectContaining({ target: "section", id: "text-one" }) }), "https://preview.example");
    await click(e.publishedVersion);
    expect(host.textContent).toContain(e.focusMissing);
    await click(e.draftVersion);
    await act(async () => row.querySelector<HTMLButtonElement>(`button[aria-label="${e.hide}"]`)!.click());
    expect(row.textContent).toContain(e.sectionHidden);
    expect(host.textContent).toContain(e.focusHidden);
    await click(en.associationPage.content.save);
    const document = api.save.mock.calls[0][3];
    expect(document.pages[0]).not.toHaveProperty("focus");
    expect(document.pages[0].sections[0].hidden).toBe(true);
  });
  it("reports a disconnected preview and offers retry without discarding a draft", async () => {
    vi.useFakeTimers(); await render(<EventPageEditor workspaceId="w" event={event} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(8001); }); expect(host.textContent).toContain(e.previewUnavailable);
    await click(e.retryPreview); expect(host.querySelector("iframe")).toBeTruthy(); expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Saved draft");
  });
});
