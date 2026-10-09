// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeJobActivity, OfficeJobActivityView, officeBrianScope } from "../job-activity";
import { presentationFixture, uid } from "./editor-fixtures";
import { resumeOfficeGeneration, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

import {resetSurfaceCache} from "@/lib/surface-cache";
vi.mock("@/lib/workspace-context", () => ({useOptionalWorkspaceContext: () => ({workspaceId: "workspace-a", me: {id: "viewer-a"}})}));
afterEach(() => { resetSurfaceCache(); streams.map.clear(); });

vi.mock("@/lib/office/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/office/api")>(),
  resumeOfficeGeneration:vi.fn(async()=>({artifactId:"draft",jobId:"job"})),
}));

// Job progress arrives on the per-job stream; tests drive a fake of it.
const streams = vi.hoisted(() => ({ map: new Map<string, unknown>(), listeners: new Set<() => void>() }));
vi.mock("@/lib/office/job-stream", async () => {
  const React = await import("react");
  const idle = { job: null, events: [], connection: "live", ended: null };
  const read = (id?: string | null) => (id && streams.map.get(id)) || idle;
  return {
    readOfficeJobStream: read,
    useOfficeJobStream: (id?: string | null) => React.useSyncExternalStore((listener: () => void) => { streams.listeners.add(listener); return () => { streams.listeners.delete(listener); }; }, () => read(id)),
  };
});
function setStream(jobId: string, job: OfficeJob, events: OfficeJobEvent[] = []) {
  streams.map.set(jobId, { job, events, connection: "live", ended: null });
  for (const listener of streams.listeners) listener();
}

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(job: OfficeJob | null, options: Partial<Parameters<typeof OfficeJobActivityView>[0]> = {}) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <OfficeJobActivityView
        job={job}
        events={[]}
        instruction=""
        scope={{ kind: "slide", slide: 1 }}
        canRequestRevision
        onInstructionChange={vi.fn()}
        onSubmit={vi.fn()}
        {...options}
      />
    </I18nProvider>,
  );
}

const job = (status: OfficeJob["status"]): OfficeJob => ({
  id: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  artifactId: "10000000-0000-4000-8000-000000000003",
  status,
  stage: status,
  errorCode: null,
});

describe("[COMP:app-web/office-iteration-panel] Office iteration panel", () => {
  beforeEach(() => {
    resetSurfaceCache();
    streams.map.clear();
  });

  it("uses family-neutral guidance and an accurate revision recovery path", () => {
    const html = render(job("completed"), { scope: { kind: "none" }, feedback: "applied" });
    expect(html).not.toContain("Select a slide");
    expect(html).not.toContain("Make slide 2");
    expect(html).not.toContain("Use Undo");
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.textContent).toContain(en.office.brianRevisionApplied);
  });

  it("shows the missing facts question while awaiting an answer", () => {
    const html = render({...job("needs_input"),errorCode:"material_fact_missing"}, {events:[{id:"question",seq:1,code:"office.job.needs_input",params:{question:"Please provide the required fields: INVOICE_DATE, PAYMENT_TERMS"},safeNarration:null,createdAt:"2026-01-01T00:00:00Z"}]});
    expect(html).toContain("INVOICE_DATE, PAYMENT_TERMS");
    expect(html).toContain(en.office.eventNeedsInput);
  });

  it("recovers an older template pause with no question event and no published templates",()=>{
    const html=render({...job("needs_input"),errorCode:"template_ambiguous",canResumeTemplate:true,templateChoices:[]},{events:[{id:"pause",seq:3,code:"office.job.needs_input",params:{reason:"template_ambiguous"},safeNarration:null,createdAt:"2026-01-01T00:00:00Z"}],templatesHref:"/w/workspace/office/templates"});
    expect(html).toContain(en.office.templateSelectionQuestion);
    const host=document.createElement("div");host.innerHTML=html;
    expect(host.textContent).toContain(en.office.noPublishedTemplateForDraft);
    expect(html).toContain("/w/workspace/office/templates");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain(en.office.iterationActiveHint);
  });

  it("offers explicit template selection and resumes the same artifact and job",async()=>{
    const paused={...job("needs_input"),errorCode:"template_ambiguous",canResumeTemplate:true,templateChoices:[{templateVersionId:"template-version",name:"Quarterly worksheet"}]};
    setStream(paused.id,paused);
    vi.mocked(resumeOfficeGeneration).mockClear();
    const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
    try {
      await act(async()=>root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeJobActivity jobId={paused.id} workspaceId="workspace-a" targetIds={[]} canRequestRevision={false} onRequestRevision={vi.fn()} onRevisionCompleted={vi.fn()}/></I18nProvider>));
      expect(host.textContent).toContain(en.office.templateSelectionQuestion);
      expect(host.querySelector("textarea")).toBeNull();
      const trigger=host.querySelector('[role="combobox"]')!;
      await act(async()=>trigger.dispatchEvent(new MouseEvent("click",{bubbles:true})));
      const option=Array.from(document.querySelectorAll('[role="option"]')).find(node=>node.textContent?.includes("Quarterly worksheet"))!;
      expect(option).toBeTruthy();
      await act(async()=>option.dispatchEvent(new MouseEvent("click",{bubbles:true})));
      const resume=Array.from(host.querySelectorAll("button")).find(node=>node.textContent===en.office.resumeGeneration)!;
      await act(async()=>resume.click());
      expect(resumeOfficeGeneration).toHaveBeenCalledWith({artifactId:paused.artifactId,jobId:paused.id,templateVersionId:"template-version"});
    } finally {act(()=>root.unmount());host.remove();}
  });

  it("reads a missing-fact question from the bounded job when events are legacy",()=>{
    const html=render({...job("needs_input"),errorCode:"material_fact_missing",inputQuestion:"Please provide the required fields: PAYMENT_TERMS"});
    expect(html).toContain("PAYMENT_TERMS");
    expect(html).toContain(en.office.generationAnswerHint);
  });

  it("shows one failure alert for a failed revision", () => {
    const html = render(job("failed"), { feedback: "failed" });
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html.split(en.office.brianRevisionFailed)).toHaveLength(2);
  });

  it("identifies a persisted revision failure after reloading", () => {
    const html = render({ ...job("failed"), errorCode: "revision_failed" });
    expect(html).toContain(en.office.brianRevisionFailed);
    expect(html).not.toContain(en.office.generationFailedBody);
  });
  it("anchors the Brian composer after collapsed run activity", () => {
    const html = render(job("running"), { events: [{ id: "event-1", seq: 1, code: "office.job.objects_constructed", params: {}, safeNarration: null, createdAt: "2026-08-05T00:00:00.000Z" }] });
    expect(html).toContain(en.office.editWithBrian);
    expect(html).toContain(en.office.iterationPlaceholder);
    expect(html).toContain(en.office.askBrian);
    expect(html).toContain(`<summary`);
    expect(html.indexOf(en.office.askBrian)).toBeGreaterThan(html.indexOf(en.office.runActivity));
    expect(html).not.toContain("<details open");
    expect(html).not.toContain(en.office.steer);
  });

  it("sends on Enter, preserves Shift+Enter and IME composition, and respects disabled submission", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const paint = (canRequestRevision: boolean) => act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeJobActivityView job={null} events={[]} instruction="Clarify this" scope={{ kind: "targets", count: 1 }} canRequestRevision={canRequestRevision} onInstructionChange={vi.fn()} onSubmit={onSubmit} /></I18nProvider>));
    try {
      paint(true);
      const input = host.querySelector("textarea")!;
      const press = (options: KeyboardEventInit) => act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options })); });
      press({ shiftKey: true });
      press({ isComposing: true });
      expect(onSubmit).not.toHaveBeenCalled();
      press({});
      expect(onSubmit).toHaveBeenCalledTimes(1);
      paint(false);
      press({});
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally { act(() => root.unmount()); host.remove(); }
  });

  it("keeps Brian as the primary edit path after generation and names the exact scope", () => {
    const html = render(job("completed"), { scope: { kind: "objects", slide: 3, count: 2 } });
    expect(html).toContain(en.office.brianEditHint);
    expect(html).toContain(en.office.brianScope);
    expect(html).toContain(en.office.brianScopeObjects.replace("{slide}", "3").replace("{count}", "2"));
    expect(html).toContain(en.office.iterationPlaceholder);
    expect(html).toContain(en.office.askBrian);
    expect(html).not.toContain(en.office.openComments);
  });

  it("disables Brian editing with an owned reason when no scope is selected", () => {
    const html = render(job("completed"), { scope: { kind: "none" }, canRequestRevision: false, requestDisabledReason: en.office.brianSelectionRequired, instruction: "Shorten this" });
    expect(html).toContain(en.office.brianScopeNone);
    expect(html).toContain(en.office.brianSelectionRequired);
    expect(html).toContain("disabled");
  });

  it("derives stable slide and object scope labels from Presentation target IDs", () => {
    const snapshot = presentationFixture();
    expect(officeBrianScope(snapshot, [uid(63)])).toEqual({ kind: "slide", slide: 1 });
    expect(officeBrianScope(snapshot, [uid(70)])).toEqual({ kind: "object", slide: 1 });
    expect(officeBrianScope(snapshot, [uid(70), uid(72)])).toEqual({ kind: "objects", slide: 1, count: 2 });
    expect(officeBrianScope(snapshot, [uid(999)])).toEqual({ kind: "targets", count: 1 });
  });

  it("submits a terminal selection directly from the Brian tab", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onRequestRevision = vi.fn(async () => ({ jobId: "revision-job", mode: "direct" as const }));
    await act(async () => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeJobActivity snapshot={presentationFixture()} targetIds={[uid(70)]} canRequestRevision onRequestRevision={onRequestRevision} onRevisionCompleted={vi.fn()} /></I18nProvider>));
    const input = host.querySelector<HTMLTextAreaElement>("#office-brian-instruction")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => { setter?.call(input, "Make this title shorter"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(onRequestRevision).toHaveBeenCalledWith("Make this title shorter");
    expect(host.textContent).toContain(en.office.brianRevisionQueued);
    expect(input.value).toBe("Make this title shorter");
    expect(input.disabled).toBe(true);
    await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(onRequestRevision).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
  });

  it.each(["failed", "completed"] as const)("retains failed instructions but clears successful ones: %s", async (status) => {
    setStream("revision-job", { ...job(status), id: "revision-job" });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onRevisionCompleted = vi.fn();
    const onRequestRevision = vi.fn(async () => ({ jobId: "revision-job", mode: "direct" as const }));
    try {
      await act(async () => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeJobActivity snapshot={presentationFixture()} targetIds={[uid(70)]} canRequestRevision onRequestRevision={onRequestRevision} onRevisionCompleted={onRevisionCompleted} /></I18nProvider>));
      const input = host.querySelector<HTMLTextAreaElement>("textarea")!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      await act(async () => { setter.call(input, "Clarify the key points"); input.dispatchEvent(new Event("input", { bubbles: true })); });
      await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      expect(input.value).toBe(status === "failed" ? "Clarify the key points" : "");
      expect(input.disabled).toBe(false);
      expect(onRevisionCompleted).toHaveBeenCalledTimes(status === "completed" ? 1 : 0);
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(status === "failed" ? 1 : 0);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it("explains a typed presentation-fit failure with an actionable reason", () => {
    const html = render({ ...job("failed"), errorCode: "presentation_fit_failed" });
    expect(html).toContain(en.office.presentationFitFailed);
    expect(html).toContain(en.office.presentationFitFailedBody);
    expect(html).toContain('role="alert"');
  });

  it("explains an exhausted presentation-plan failure without exposing validation details", () => {
    const html = render({ ...job("failed"), errorCode: "presentation_plan_failed" });
    expect(html).toContain(en.office.presentationPlanFailed);
    expect(html).toContain(en.office.presentationPlanFailedBody);
    expect(html).not.toContain("unrecognized_keys");
    expect(html).not.toContain("slides.6.fields.7");
  });

  it("labels a running job by its latest persisted step and spins only on a live connection", () => {
    const steps = [{ id: "e1", seq: 1, code: "office.job.started", params: {}, safeNarration: null, createdAt: "2026-10-10T00:00:00Z" }];
    const live = render(job("running"), { events: steps });
    expect(live).toContain(en.office.eventStarted);
    expect(live).toContain("animate-spin");
    const dropped = render(job("running"), { events: steps, connection: "reconnecting" });
    expect(dropped).toContain(en.office.jobReconnecting);
    expect(dropped).not.toContain("animate-spin");
    expect(dropped).not.toContain(en.office.iterationActiveHint);
  });

  it("renders the server narration for an unmapped step and omits a step with neither", () => {
    const html = render(job("running"), { events: [
      { id: "e1", seq: 1, code: "office.job.future_stage", params: {}, safeNarration: "Server step", createdAt: "2026-10-10T00:00:00Z" },
      { id: "e2", seq: 2, code: "office.job.silent_stage", params: {}, safeNarration: null, createdAt: "2026-10-10T00:00:00Z" },
    ] });
    expect(html.split("Server step").length).toBeGreaterThan(1);
    expect(html.match(/<li/g)).toHaveLength(1);
  });

  it("renders a skeleton, not text, before the stream's first frame", () => {
    const html = render(null, { loading: true });
    expect(html).toContain('data-office-job-skeleton="true"');
    expect(html).not.toContain(en.office.brianEditHint);
  });
});

