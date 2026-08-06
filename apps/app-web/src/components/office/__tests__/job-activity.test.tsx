import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OfficeJobActivityView } from "../job-activity";
import type { OfficeJob } from "@/lib/office/api";

function render(job: OfficeJob | null, events: Parameters<typeof OfficeJobActivityView>[0]["events"] = []) {
  return renderToStaticMarkup(
    <I18nProvider locale="en" dict={en as unknown as Dictionary}>
      <OfficeJobActivityView job={job} events={events} instruction="" onInstructionChange={vi.fn()} onSubmit={vi.fn()} onOpenComments={vi.fn()} />
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
    const html = render(job("running"), [{ id: "event-1", seq: 1, code: "office.job.objects_constructed", params: {}, safeNarration: null, createdAt: "2026-08-05T00:00:00.000Z" }]);
    expect(html).toContain(en.office.iterateWithBrian);
    expect(html).toContain(en.office.iterationPlaceholder);
    expect(html).toContain(en.office.askBrian);
    expect(html).toContain(`<summary`);
    expect(html.indexOf(en.office.askBrian)).toBeLessThan(html.indexOf(en.office.runActivity));
    expect(html).not.toContain(en.office.steer);
  });

  it("routes completed work to the explicit @Brian comment flow", () => {
    const html = render(job("completed"));
    expect(html).toContain(en.office.revisionReadyHint);
    expect(html).toContain(en.office.openComments);
    expect(html).not.toContain(en.office.iterationPlaceholder);
  });

  it("explains a typed presentation-fit failure with an actionable reason", () => {
    const html = render({ ...job("failed"), errorCode: "presentation_fit_failed" });
    expect(html).toContain(en.office.presentationFitFailed);
    expect(html).toContain(en.office.presentationFitFailedBody);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain(en.office.revisionReadyHint);
  });
});
