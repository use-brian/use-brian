// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeArtifactSnapshot, OfficeTemplateRoutingDraft } from "@use-brian/office-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { getOfficeTemplateRouting, saveOfficeTemplateRouting } from "@/lib/office/api";
import { TemplateRoutingInspector } from "../template-routing-inspector";
import { reconcileTokenRouting } from "../token-template-routing";
import { documentFixture, spreadsheetFixture, uid } from "./editor-fixtures";

import { attachOfficeMetadata } from "@/lib/office/metadata";
import { resetSurfaceCache } from "@/lib/surface-cache";
vi.mock("@/lib/office/api", async original => ({ ...await original<Record<string, unknown>>(), getOfficeTemplateRouting: vi.fn(), saveOfficeTemplateRouting: vi.fn() }));
vi.mock("@/lib/workspace-context", () => ({useOptionalWorkspaceContext: () => ({workspaceId: "workspace", me: {id: "viewer"}})}));
const bounded = (value: OfficeTemplateRoutingDraft) => attachOfficeMetadata(structuredClone(value), 30_000, performance.now(), "viewer");
let serverRouting: OfficeTemplateRoutingDraft;
const empty: OfficeTemplateRoutingDraft = { source: "upload", fields: [], slideRecipes: [] };
function documentTemplate() {
  const snapshot = documentFixture();
  snapshot.sections[0]!.header[0]!.text = "{{NAME}}";
  return snapshot;
}
function spreadsheetTemplate() {
  const snapshot = spreadsheetFixture();
  snapshot.worksheets[0]!.cells[0]!.value = "{{NAME}}";
  return snapshot;
}
function routing(snapshot: OfficeArtifactSnapshot) { return reconcileTokenRouting(empty, snapshot, en.office.routingTokenDefaultInstruction); }

let host: HTMLDivElement;
let root: Root;
const onState = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks(); resetSurfaceCache(); serverRouting = empty;
  vi.mocked(getOfficeTemplateRouting).mockImplementation(async () => bounded(serverRouting));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(saveOfficeTemplateRouting).mockImplementation(async (_id, value) => { serverRouting = value; return value; });
});
afterEach(() => { act(() => root.unmount()); host.remove(); resetSurfaceCache(); vi.unstubAllGlobals(); });
async function render(snapshot: OfficeArtifactSnapshot, initialRouting?: OfficeTemplateRoutingDraft, templateId = uid(99)) {
  if (initialRouting) serverRouting = initialRouting;
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><TemplateRoutingInspector templateId={templateId} snapshot={snapshot} selectedTargetIds={[uid(5), uid(91)]} initialRouting={initialRouting ? bounded(initialRouting) : undefined} onStateChange={onState} /></I18nProvider>));
}
function input(label: string) {
  const found = [...host.querySelectorAll("label")].find((item) => item.querySelector("span")?.textContent === label)?.querySelector("input,textarea");
  if (!found) throw new Error(`Missing input ${label}`);
  return found as HTMLInputElement | HTMLTextAreaElement;
}
function change(label: string, value: string) {
  const element = input(label);
  act(() => {
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function saveButton() { return [...host.querySelectorAll("button")].find((button) => button.textContent === en.office.routingSave || button.textContent === en.office.routingSaving)!; }

describe("[COMP:app-web/office-template-routing] DOCX/XLSX token configuration", () => {
  it.each([documentTemplate, spreadsheetTemplate])("reconciles names and exact locations, keeping metadata only for unchanged names", (fixture) => {
    const snapshot = fixture();
    const initial = routing(snapshot);
    initial.fields[0]!.required = true;
    initial.fields[0]!.label = "Reviewed name";
    initial.fields[0]!.maxLength = 40;
    expect(reconcileTokenRouting(initial, snapshot, "instruction")).toBe(initial);
    const next = structuredClone(snapshot);
    if (next.family === "document") {
      next.sections[1]!.header[0]!.text = "{{NAME}} {{NEW}}";
      next.sections[0]!.header[0]!.text = "{{RENAMED}}";
    } else {
      next.worksheets[0]!.cells[1]!.valueType = "string";
      next.worksheets[0]!.cells[1]!.value = "{{NAME}} {{NEW}}";
      next.worksheets[0]!.cells[0]!.value = "{{RENAMED}}";
    }
    const reconciled = reconcileTokenRouting(initial, next, "instruction");
    expect(reconciled.fields.find((field) => field.name === "NAME")).toMatchObject({ id: initial.fields[0]!.id, label: "Reviewed name", required: true, maxLength: 40 });
    expect(reconciled.fields.find((field) => field.name === "RENAMED")).toMatchObject({ required: false, label: "RENAMED", aiInstruction: "instruction" });
    expect(reconciled.fields.find((field) => field.name === "NAME")!.targetIds).not.toEqual(initial.fields[0]!.targetIds);
    expect(reconciled.fields.map((field) => field.name)).toContain("NEW");
    expect(reconcileTokenRouting(reconciled, fixture().family === "document" ? documentFixture() : spreadsheetFixture(), "instruction").fields).toEqual([]);
  });

  it.each([documentTemplate, spreadsheetTemplate])("loads, edits and saves all field metadata through existing routing APIs", async (fixture) => {
    const snapshot = fixture();
    vi.mocked(getOfficeTemplateRouting).mockResolvedValueOnce(bounded(empty));
    await render(snapshot);
    expect(getOfficeTemplateRouting).toHaveBeenCalledWith(uid(99));
    expect(host.textContent).toContain("{{NAME}}");
    expect(host.textContent).toContain(en.office.routingTokenSyntax);
    expect(host.querySelector('[data-template-routing-field="selected"]')).not.toBeNull();
    if (snapshot.family === "spreadsheet") {
      expect(host.textContent).toContain("Invoice!A1");
      expect(host.textContent).toContain(en.office.routingTokenAppend);
    }
    expect(onState).toHaveBeenLastCalledWith({ ready: true, dirty: true, saving: false });
    change(en.office.routingFieldLabel, "Account name");
    change(en.office.routingTokenMaxLength, "42");
    change(en.office.routingInstruction, "Use the supplied account name.");
    await act(async () => (host.querySelector('[role="checkbox"]') as HTMLElement).click());
    await act(async () => (host.querySelector('[aria-label="Content type"]') as HTMLElement).click());
    const option = [...document.querySelectorAll('[role="option"]')].find((element) => element.textContent === en.office.routingFieldTypes.number) as HTMLElement;
    expect(option).toBeTruthy();
    await act(async () => option.click());
    await act(async () => saveButton().click());
    expect(saveOfficeTemplateRouting).toHaveBeenCalledWith(uid(99), expect.objectContaining({ fields: [expect.objectContaining({ name: "NAME", label: "Account name", type: "number", required: true, maxLength: 42, aiInstruction: "Use the supplied account name.", targetIds: [snapshot.family === "document" ? uid(5) : uid(91)] })] }));
    expect(onState).toHaveBeenLastCalledWith({ ready: true, dirty: false, saving: false });
    expect(host.textContent).toContain(en.office.routingSaved);
    expect(host.querySelector(`input[value="NAME"]`)).toBeNull();
  });

  it("blocks invalid or empty field contracts and locked cells instead of silently publishing", async () => {
    const snapshot = spreadsheetTemplate();
    const draft = routing(snapshot);
    await render(snapshot, draft);
    change(en.office.routingFieldLabel, "   ");
    expect(saveButton().disabled).toBe(true);
    expect(onState).toHaveBeenLastCalledWith({ ready: false, dirty: true, saving: false });
    change(en.office.routingFieldLabel, "Name");
    change(en.office.routingTokenMaxLength, "0");
    expect(saveButton().disabled).toBe(true);
    change(en.office.routingTokenMaxLength, "");
    expect(saveButton().disabled).toBe(false);
    const locked = structuredClone(snapshot);
    locked.worksheets[0]!.cells[0]!.locked = true;
    await render(locked, draft);
    expect(host.textContent).toContain("Locked placeholders cannot be filled: NAME");
    expect(saveButton().disabled).toBe(true);
    await render(spreadsheetFixture(), draft);
    expect(host.textContent).toContain(en.office.routingTokenEmpty);
    expect(onState).toHaveBeenLastCalledWith({ ready: false, dirty: true, saving: false });
  });

  it("does not mark changed bindings saved when an older PUT finishes", async () => {
    const snapshot = documentTemplate();
    const draft = routing(snapshot);
    await render(snapshot, draft);
    change(en.office.routingFieldLabel, "Reviewed");
    let finish!: (value: OfficeTemplateRoutingDraft) => void;
    vi.mocked(saveOfficeTemplateRouting).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => saveButton().click());
    const submitted = vi.mocked(saveOfficeTemplateRouting).mock.calls[0]![1];
    const next = structuredClone(snapshot);
    next.sections[0]!.header[0]!.text = "{{RENAMED}}";
    await render(next, draft);
    await act(async () => finish(submitted));
    expect(host.textContent).toContain("{{RENAMED}}");
    expect(host.textContent).not.toContain("{{NAME}}");
    expect(onState).toHaveBeenLastCalledWith({ ready: true, dirty: true, saving: false });
    expect(host.textContent).toContain(en.office.routingUnsaved);
  });

  it("retries load and save errors without dropping pending edits", async () => {
    const snapshot = documentTemplate();
    vi.mocked(getOfficeTemplateRouting).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(bounded(empty));
    await render(snapshot);
    expect(host.textContent).toContain(en.office.routingLoadFailed);
    await act(async () => host.querySelector("button")!.click());
    change(en.office.routingFieldLabel, "Keep this edit");
    vi.mocked(saveOfficeTemplateRouting).mockRejectedValueOnce(new Error("offline"));
    await act(async () => saveButton().click());
    expect(host.textContent).toContain(en.office.routingSaveFailed);
    expect(input(en.office.routingFieldLabel).value).toBe("Keep this edit");
    await act(async () => saveButton().click());
    expect(host.textContent).toContain(en.office.routingSaved);
  });

  it("has localized syntax, lock and append explanations in every supported locale", () => {
    for (const dict of [en, ja, zh, zhCN]) {
      expect(dict.office.routingTokenSyntax).toContain("{{CUSTOMER_NAME}}");
      expect(dict.office.routingTokenLocked).toContain("{names}");
      expect(dict.office.routingTokenAppend.length).toBeGreaterThan(20);
      expect(dict.office.routingTokenInvalid).toContain("128");
    }
  });
});
