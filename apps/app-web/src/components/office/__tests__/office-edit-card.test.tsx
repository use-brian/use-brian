// @vitest-environment jsdom
/**
 * Office edit card. [COMP:app-web/office-edit-card]
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { OfficeJob, OfficeJobEvent } from "@/lib/office/api";
import { OfficeEditCard, officeEditResult } from "../office-edit-card";

const streams = vi.hoisted(() => ({ map: new Map<string, unknown>(), listeners: new Set<() => void>() }));
vi.mock("@/lib/office/job-stream", async () => {
  const React = await import("react");
  const idle = { job: null, events: [], connection: "reconnecting", ended: null };
  const read = (id?: string | null) => (id && streams.map.get(id)) || idle;
  return {
    useOfficeJobStream: (id?: string | null) => React.useSyncExternalStore((listener: () => void) => { streams.listeners.add(listener); return () => { streams.listeners.delete(listener); }; }, () => read(id)),
  };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const JOB = "job-1";
const job = (status: OfficeJob["status"]): OfficeJob => ({ id: JOB, workspaceId: "w", artifactId: "a", status, stage: status, errorCode: null });
const event = (seq: number, code: string, params: OfficeJobEvent["params"] = {}): OfficeJobEvent => ({ id: `e${seq}`, seq, code, params, safeNarration: null, createdAt: "2026-10-10T00:00:00Z" });
function push(state: { job: OfficeJob | null; events?: OfficeJobEvent[]; connection?: string; ended?: string | null }) {
  act(() => {
    streams.map.set(JOB, { events: [], connection: "live", ended: null, ...state });
    for (const listener of streams.listeners) listener();
  });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { streams.map.clear(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function render(props: Partial<Parameters<typeof OfficeEditCard>[0]> = {}) {
  act(() => root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><OfficeEditCard jobId={JOB} mode="direct" {...props} /></I18nProvider>));
}

describe("[COMP:app-web/office-edit-card] Office edit card", () => {
  it("reads the queued job from the revise tool result excerpt", () => {
    expect(officeEditResult({ name: "reviseOfficeArtifact", status: "done", output: JSON.stringify({ jobId: JOB, mode: "proposal" }) })).toEqual({ jobId: JOB, mode: "proposal" });
    expect(officeEditResult({ name: "reviseOfficeArtifact", status: "retried", output: "{}" })).toBeNull();
    expect(officeEditResult({ name: "getOfficeArtifact", status: "done", output: JSON.stringify({ jobId: JOB, mode: "direct" }) })).toBeNull();
    expect(officeEditResult({ name: "reviseOfficeArtifact", status: "done", output: "not json" })).toBeNull();
  });

  it("goes from skeleton to the latest persisted stage to applied, and refreshes the editor once on done", () => {
    const onSettled = vi.fn();
    const onOpenHistory = vi.fn();
    render({ onSettled, onOpenHistory });
    expect(host.querySelector('[data-office-job-skeleton="true"]')).not.toBeNull();
    push({ job: job("running"), events: [event(1, "office.job.started"), event(2, "office.job.revision_drafted")] });
    expect(host.textContent).toContain(en.office.eventRevisionDrafted);
    expect(host.querySelector(".animate-spin")).not.toBeNull();
    expect(onSettled).not.toHaveBeenCalled();
    push({ job: job("completed"), events: [event(1, "office.job.started"), event(3, "office.job.completed", { version: 4 })], ended: "done" });
    push({ job: job("completed"), events: [event(1, "office.job.started"), event(3, "office.job.completed", { version: 4 })], ended: "done" });
    expect(host.textContent).toContain(en.office.editCardApplied);
    expect(onSettled).toHaveBeenCalledTimes(1);
    const history = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === en.office.openHistory)!;
    act(() => history.click());
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("says proposal ready, not applied, for a Comment sender or a drifted version", () => {
    render({ mode: "direct", onOpenHistory: vi.fn() });
    push({ job: job("completed"), events: [event(2, "office.job.completed", { proposal: true })], ended: "done" });
    expect(host.textContent).toContain(en.office.editCardProposal);
    expect(host.textContent).not.toContain(en.office.openHistory);
  });

  it("reports a failed edit as an alert and still refreshes", () => {
    const onSettled = vi.fn();
    render({ onSettled });
    push({ job: job("failed"), events: [event(2, "office.job.failed", { code: "revision_failed" })], ended: "done" });
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(en.office.editCardFailed);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("names a dropped stream instead of presenting the last stage as live", () => {
    render();
    push({ job: job("running"), events: [event(1, "office.job.started")], connection: "reconnecting" });
    expect(host.textContent).toContain(en.office.jobReconnecting);
    expect(host.querySelector(".animate-spin")).toBeNull();
  });
});
