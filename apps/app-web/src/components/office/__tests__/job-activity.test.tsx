// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeJobActivity, OfficeJobActivityView, officeBrianScope } from "../job-activity";
import { presentationFixture, uid } from "./editor-fixtures";
import type { OfficeJob } from "@/lib/office/api";

vi.mock("@/lib/office/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/office/api")>(),
  getOfficeJob: vi.fn(() => new Promise(() => undefined)),
}));

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
  it("puts the plain-language Brian composer before collapsed run telemetry", () => {
    const html = render(job("running"), { events: [{ id: "event-1", seq: 1, code: "office.job.objects_constructed", params: {}, safeNarration: null, createdAt: "2026-08-05T00:00:00.000Z" }] });
    expect(html).toContain(en.office.editWithBrian);
    expect(html).toContain(en.office.iterationPlaceholder);
    expect(html).toContain(en.office.askBrian);
    expect(html).toContain(`<summary`);
    expect(html.indexOf(en.office.askBrian)).toBeLessThan(html.indexOf(en.office.runActivity));
    expect(html).not.toContain(en.office.steer);
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
    act(() => root.unmount());
    host.remove();
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
});
