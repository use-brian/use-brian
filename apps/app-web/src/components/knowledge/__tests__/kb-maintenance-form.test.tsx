// @vitest-environment jsdom
/**
 * [COMP:app-web/kb-maintenance-form] Self-maintain config form.
 *
 * The anti-slop contract must hold client-side too: the empty state offers
 * setup only on a writable source, the edit form keeps Save gated until the
 * mandatory fields are filled, and a save PUTs the parsed config (path scope
 * split into prefixes, threshold as a fraction). The summary view shows the
 * suggestion-first framing + budget usage.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockAuthFetch = vi.fn();
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

import { KbMaintenanceForm } from "../kb-maintenance-form";

const dict = en as unknown as Dictionary;
const copy = dict.studioPage.knowledgePage.maintenance;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(ui: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <I18nProvider locale="en" dict={dict}>
        {ui}
      </I18nProvider>,
    );
  });
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function findButton(label: string): HTMLButtonElement {
  return Array.from(host!.querySelectorAll("button")).find((b) => b.textContent === label)!;
}

function fieldByLabel(label: string): HTMLTextAreaElement {
  const span = Array.from(host!.querySelectorAll("label > span")).find(
    (s) => s.textContent === label,
  )!;
  return span.parentElement!.querySelector("textarea")!;
}

describe("[COMP:app-web/kb-maintenance-form] KbMaintenanceForm", () => {
  it("offers setup on a writable source, and the not-writable notice otherwise", async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ agent: null, writable: true }) });
    render(<KbMaintenanceForm workspaceId="ws-1" sourceId="src-1" />);
    await flush();
    expect(host!.textContent).toContain(copy.intro);
    expect(findButton(copy.setUpAction)).toBeTruthy();

    act(() => root!.unmount());
    root = null;
    host?.remove();
    mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ agent: null, writable: false }) });
    render(<KbMaintenanceForm workspaceId="ws-1" sourceId="src-1" />);
    await flush();
    expect(host!.textContent).toContain(copy.notWritable);
    expect(findButton(copy.setUpAction)).toBeUndefined();
  });

  it("keeps Save gated until the mandatory fields are filled, then PUTs the parsed config", async () => {
    mockAuthFetch.mockResolvedValue({ ok: true, json: async () => ({ agent: null, writable: true }) });
    render(<KbMaintenanceForm workspaceId="ws-1" sourceId="src-1" />);
    await flush();
    act(() => findButton(copy.setUpAction).click());

    // Style contract comes pre-seeded; charter + scope start empty → gated.
    const save = findButton(copy.save);
    expect(save.disabled).toBe(true);

    act(() => setValue(
      fieldByLabel(copy.charterLabel),
      "Product and API documentation for Acme. Out of scope: finances and HR.",
    ));
    expect(findButton(copy.save).disabled).toBe(true);
    act(() => setValue(fieldByLabel(copy.scopeLabel), "products/\nguides/"));
    expect(findButton(copy.save).disabled).toBe(false);

    // After the PUT the form re-loads; both answers need a full agent shape.
    const savedAgent = {
      id: "ag-1",
      sourceId: "src-1",
      workflowId: "wf-1",
      enabled: true,
      charter: "Product and API documentation for Acme. Out of scope: finances and HR.",
      pathScope: ["products/", "guides/"],
      signals: { mode: "events" },
      similarityThreshold: 0.8,
      styleContract: copy.styleContractDefault,
      sensitivityCeiling: "internal",
      weeklyProposalBudget: 5,
    };
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ agent: savedAgent, attemptsThisWeek: 0, writable: true }),
    });
    await act(async () => { findButton(copy.save).click(); });

    const putCall = mockAuthFetch.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    )!;
    expect(String(putCall[0])).toContain("/sources/src-1/maintenance");
    const body = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      enabled: true,
      pathScope: ["products/", "guides/"],
      signals: { mode: "events" },
      similarityThreshold: 0.8,
      sensitivityCeiling: "internal",
      weeklyProposalBudget: 5,
    });
    expect(body.styleContract).toBe(copy.styleContractDefault);
  });

  it("renders the summary view with suggestion-first framing and budget usage", async () => {
    mockAuthFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        agent: {
          id: "ag-1",
          sourceId: "src-1",
          workflowId: "wf-1",
          enabled: true,
          charter: "c".repeat(60),
          pathScope: ["products/"],
          signals: { mode: "daily", time: "09:00" },
          similarityThreshold: 0.8,
          styleContract: "s".repeat(30),
          sensitivityCeiling: "internal",
          weeklyProposalBudget: 5,
        },
        attemptsThisWeek: 2,
        writable: true,
      }),
    });
    render(<KbMaintenanceForm workspaceId="ws-1" sourceId="src-1" />);
    await flush();
    const text = host!.textContent ?? "";
    expect(text).toContain(copy.statusOn);
    expect(text).toContain(copy.suggestionFirstBadge);
    expect(text).toContain("2 of 5 proposals used this week");
    expect(text).toContain("products/");
  });
});
