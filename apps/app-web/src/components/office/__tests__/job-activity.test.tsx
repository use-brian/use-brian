// @vitest-environment jsdom
/**
 * The Office file's Brian rail: generation status, then one shared
 * conversation per file. [COMP:app-web/office-iteration-panel]
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeJobActivity, OfficeJobActivityView, officeBrianScope } from "../job-activity";
import { presentationFixture, uid } from "./editor-fixtures";
import { getOfficeConversation, resumeOfficeGeneration, startOfficeConversation, steerOfficeJob, type OfficeJob, type OfficeJobEvent } from "@/lib/office/api";

const net = vi.hoisted(() => ({ chatBodies: [] as unknown[], chatFrames: [] as Array<[string, unknown]>, sessionRows: [] as unknown[], keepOpen: false }));
vi.mock("@/lib/workspace-context", () => ({ useOptionalWorkspaceContext: () => ({ workspaceId: "workspace-a", me: { id: "viewer-a" } }) }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-a" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/doc/composer-controls", () => ({
  useComposerControls: () => ({ model: "standard", setModel: vi.fn(), plan: "pro", researchMode: false, setResearchMode: vi.fn(), researchQuota: null, researchExhausted: false }),
  ComposerControls: () => <span data-composer-controls="true" />,
}));
vi.mock("@/lib/api/sessions", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/api/sessions")>(), fetchSessionMessages: vi.fn(async () => net.sessionRows) }));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/stream")) return new Response(new ReadableStream({ start() { /* follow stream stays open */ } }), { status: 200 });
    if (url.endsWith("/api/chat")) {
      net.chatBodies.push(JSON.parse(String(init?.body)));
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        for (const [event, data] of net.chatFrames) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        if (!net.keepOpen) controller.close();
      } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }),
}));
vi.mock("@/lib/office/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/office/api")>(),
  getOfficeConversation: vi.fn(async () => ({ sessionId: null, canSend: true, role: "edit", assistant: { id: "assistant-a", name: "Brian" } })),
  startOfficeConversation: vi.fn(async () => ({ sessionId: "session-a", assistant: { id: "assistant-a", name: "Brian" } })),
  steerOfficeJob: vi.fn(async () => undefined),
  resumeOfficeGeneration: vi.fn(async () => ({ artifactId: "draft", jobId: "job" })),
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

const ARTIFACT = "10000000-0000-4000-8000-000000000003";
const job = (status: OfficeJob["status"], jobKind: OfficeJob["jobKind"] = "create"): OfficeJob => ({
  id: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  artifactId: ARTIFACT,
  jobKind,
  status,
  stage: status,
  errorCode: null,
});

function render(state: OfficeJob | null, options: Partial<Parameters<typeof OfficeJobActivityView>[0]> = {}) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <OfficeJobActivityView job={state} events={[]} instruction="" scope={{ kind: "slide", slide: 1 }} canSend onInstructionChange={vi.fn()} onSubmit={vi.fn()} {...options} />
    </I18nProvider>,
  );
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  streams.map.clear();
  net.chatBodies = [];
  net.chatFrames = [];
  net.sessionRows = [];
  net.keepOpen = false;
  vi.mocked(steerOfficeJob).mockClear();
  vi.mocked(startOfficeConversation).mockClear();
  vi.mocked(resumeOfficeGeneration).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function mount(props: Partial<Parameters<typeof OfficeJobActivity>[0]> = {}) {
  await act(async () => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}>
    <OfficeJobActivity workspaceId="workspace-a" artifactId={ARTIFACT} snapshot={presentationFixture()} targetIds={[]} onRevisionCompleted={vi.fn()} {...props} />
  </I18nProvider>));
}
async function type(text: string) {
  const input = host.querySelector<HTMLTextAreaElement>("#office-brian-instruction")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
  return input;
}
async function send() {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("[COMP:app-web/office-iteration-panel] Office file conversation", () => {
  it("enables Send with nothing selected and starts a chat turn in the file's shared thread", async () => {
    await mount({ targetIds: [] });
    const input = await type("Tighten the opening slide");
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>("form button")).find((node) => node.textContent?.includes(en.office.askBrian))!;
    expect(button.disabled).toBe(false);
    await send();
    expect(startOfficeConversation).toHaveBeenCalledWith(ARTIFACT);
    expect(net.chatBodies).toEqual([expect.objectContaining({ message: "Tighten the opening slide", sessionId: "session-a", assistantId: "assistant-a", workspaceId: "workspace-a" })]);
    expect(net.chatBodies[0]).not.toHaveProperty("officeSelection");
    expect(input.value).toBe("");
  });

  it("sends the selection as a dismissible focus hint, never a gate", async () => {
    await mount({ targetIds: [uid(70)] });
    expect(host.textContent).toContain(en.office.brianScope);
    await type("Make this bolder");
    await send();
    expect(net.chatBodies.at(-1)).toMatchObject({ officeSelection: { targetIds: [uid(70)] } });
    const clear = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.office.clearFocus}"]`)!;
    await act(async () => clear.click());
    expect(host.querySelector("[data-office-brian-scope]")).toBeNull();
    await type("Now shorter");
    await send();
    expect(net.chatBodies.at(-1)).not.toHaveProperty("officeSelection");
  });

  it("steers an active generation instead of starting a turn", async () => {
    const running = job("running");
    setStream(running.id, running, [{ id: "e1", seq: 1, code: "office.job.started", params: {}, safeNarration: null, createdAt: "2026-10-10T00:00:00Z" }]);
    await mount({ jobId: running.id });
    await type("Use our brand colours");
    await send();
    expect(steerOfficeJob).toHaveBeenCalledWith(running.id, "Use our brand colours");
    expect(net.chatBodies).toEqual([]);
    expect(host.querySelector('[data-office-steering="true"]')!.textContent).toContain("Use our brand colours");
  });

  it("shows a reviseOfficeArtifact result as an edit card tracking its job", async () => {
    net.chatFrames = [
      ["tool_start", { id: "call-1", name: "reviseOfficeArtifact" }],
      ["tool_result", { id: "call-1", output: JSON.stringify({ jobId: "revision-job", mode: "direct" }) }],
      ["text_delta", { text: "I started the edit." }],
    ];
    setStream("revision-job", { ...job("running", "revise"), id: "revision-job" }, [{ id: "e1", seq: 1, code: "office.job.revision_drafted", params: {}, safeNarration: null, createdAt: "2026-10-10T00:00:00Z" }]);
    // Keep the turn open so the live bubble stays mounted.
    net.keepOpen = true;
    await mount();
    await type("Shorten slide two");
    await send();
    expect(host.querySelector('[data-office-edit-card="running"]')).not.toBeNull();
    expect(host.textContent).toContain(en.office.eventRevisionDrafted);
  });

  it("lets a View-only reader read the thread but not send", async () => {
    vi.mocked(getOfficeConversation).mockResolvedValueOnce({ sessionId: "session-a", canSend: false, role: "view", assistant: { id: "assistant-a", name: "Brian" } });
    net.sessionRows = [{ id: "m1", role: "user", content: "Can you add a summary?", timestamp: "2026-10-10T00:00:00Z", senderUserId: "teammate", senderName: "Avery Example" }];
    await mount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("Can you add a summary?");
    expect(host.textContent).toContain("Avery Example");
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector('[data-office-read-only="true"]')!.textContent).toBe(en.office.chatReadOnly);
  });
});

describe("[COMP:app-web/office-iteration-panel] generation status as Brian's message", () => {
  it("uses family-neutral guidance that never asks for a selection", () => {
    const html = render(null, { scope: { kind: "none" } });
    expect(html).toContain(en.office.brianEditHint);
    expect(html).not.toContain("Select a slide");
    expect(html).not.toContain("disabled=\"\"><svg");
  });

  it("shows the missing facts question while awaiting an answer", () => {
    const html = render({ ...job("needs_input"), errorCode: "material_fact_missing" }, { events: [{ id: "question", seq: 1, code: "office.job.needs_input", params: { question: "Please provide the required fields: INVOICE_DATE, PAYMENT_TERMS" }, safeNarration: null, createdAt: "2026-01-01T00:00:00Z" }] });
    expect(html).toContain("INVOICE_DATE, PAYMENT_TERMS");
    expect(html).toContain(en.office.eventNeedsInput);
  });

  it("recovers an older template pause with no question event and no published templates", () => {
    const html = render({ ...job("needs_input"), errorCode: "template_ambiguous", canResumeTemplate: true, templateChoices: [] }, { events: [{ id: "pause", seq: 3, code: "office.job.needs_input", params: { reason: "template_ambiguous" }, safeNarration: null, createdAt: "2026-01-01T00:00:00Z" }], templatesHref: "/w/workspace/office/templates" });
    expect(html).toContain(en.office.templateSelectionQuestion);
    const node = document.createElement("div");
    node.innerHTML = html;
    expect(node.textContent).toContain(en.office.noPublishedTemplateForDraft);
    expect(html).toContain("/w/workspace/office/templates");
    expect(html).not.toContain("<textarea");
  });

  it("offers explicit template selection and resumes the same artifact and job", async () => {
    const paused = { ...job("needs_input"), errorCode: "template_ambiguous", canResumeTemplate: true, templateChoices: [{ templateVersionId: "template-version", name: "Quarterly worksheet" }] };
    setStream(paused.id, paused);
    await mount({ jobId: paused.id });
    expect(host.textContent).toContain(en.office.templateSelectionQuestion);
    expect(host.querySelector("textarea")).toBeNull();
    const trigger = host.querySelector('[role="combobox"]')!;
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes("Quarterly worksheet"))!;
    await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const resume = Array.from(host.querySelectorAll("button")).find((node) => node.textContent === en.office.resumeGeneration)!;
    await act(async () => resume.click());
    expect(resumeOfficeGeneration).toHaveBeenCalledWith({ artifactId: paused.artifactId, jobId: paused.id, templateVersionId: "template-version" });
  });

  it("explains typed failures with an actionable reason and one alert", () => {
    const fit = render({ ...job("failed"), errorCode: "presentation_fit_failed" });
    expect(fit).toContain(en.office.presentationFitFailed);
    expect(fit).toContain(en.office.presentationFitFailedBody);
    expect(fit.match(/role="alert"/g)).toHaveLength(1);
    const plan = render({ ...job("failed"), errorCode: "presentation_plan_failed" });
    expect(plan).toContain(en.office.presentationPlanFailedBody);
    expect(plan).not.toContain("unrecognized_keys");
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
    expect(html.match(/<li[\s>]/g)).toHaveLength(1);
  });

  it("renders a skeleton, not text, before the stream's first frame", () => {
    const html = render(null, { loading: true });
    expect(html).toContain('data-office-job-skeleton="true"');
    expect(html).not.toContain(en.office.brianEditHint);
  });

  it("sends on Enter, preserves Shift+Enter and IME composition", async () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const paint = (canSend: boolean) => act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeJobActivityView job={null} events={[]} instruction="Clarify this" scope={{ kind: "none" }} canSend={canSend} onInstructionChange={vi.fn()} onSubmit={onSubmit} /></I18nProvider>));
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
  });

  it("derives stable slide and object scope labels from Presentation target IDs", () => {
    const snapshot = presentationFixture();
    expect(officeBrianScope(snapshot, [uid(63)])).toEqual({ kind: "slide", slide: 1 });
    expect(officeBrianScope(snapshot, [uid(70)])).toEqual({ kind: "object", slide: 1 });
    expect(officeBrianScope(snapshot, [uid(70), uid(72)])).toEqual({ kind: "objects", slide: 1, count: 2 });
    expect(officeBrianScope(snapshot, [uid(999)])).toEqual({ kind: "targets", count: 1 });
  });
});
