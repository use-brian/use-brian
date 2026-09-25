// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { BrainRow } from "@/lib/api/brain";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch }));
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";

const workspace = vi.hoisted(() => ({ activeId: "workspace-a" }));
vi.mock("@/contexts/workspace-context", () => ({ useWorkspaces: () => workspace }));
import { BrainGroupedView } from "../grouped-view";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const onSelect = vi.fn();
const person: BrainRow = { kind: "person", id: "shared:id", name: "Ada" };
const company: BrainRow = { kind: "company", id: "shared:id", name: "Acme" };
const task: BrainRow = { kind: "tasks", id: "done", name: "Finished", status: "done" };
const fallback: BrainRow = { kind: "file_segment", id: "excerpt", name: "Excerpt" };
function render(props: Partial<ComponentProps<typeof BrainGroupedView>> = {}) {
  act(() => root.render(<I18nProvider locale="en" dict={en}>
    <ConfirmDialogProvider />
    <BrainGroupedView rows={[person, company]} graph={null} onSelect={onSelect} {...props} />
  </I18nProvider>));
}
function box(label: string) {
  const result = [...container.querySelectorAll<HTMLElement>('[role="checkbox"]')]
    .find((node) => node.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing checkbox: ${label}`);
  return result;
}
function click(node: HTMLElement) { act(() => node.click()); }
function button(text: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button:not([role="checkbox"])')]
    .find((node) => node.textContent?.includes(text));
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
const all = () => box("Select all loaded rows");
const count = () => container.querySelector('[role="status"]')?.textContent;

beforeEach(() => {
  workspace.activeId = "workspace-a";
  onSelect.mockClear();
  authFetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("[COMP:app-web/brain-grouped-view] List multi-selection", () => {
  it("keeps checkbox selection separate from row opening and distinguishes kind:id", () => {
    render();
    click(box("Select Ada"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(count()).toBe("1 selected");
    expect(all().getAttribute("aria-checked")).toBe("mixed");
    expect(box("Select Acme").getAttribute("aria-checked")).toBe("false");
    expect(box("Select Ada").closest("label")?.parentElement?.className).toContain("bg-primary/10");
    expect(container.querySelector('button button')).toBeNull();
    click(button("Ada"));
    expect(onSelect).toHaveBeenCalledWith(person);
    expect(count()).toBe("1 selected");
    click(box("Select Acme"));
    expect(count()).toBe("2 selected");
    expect(all().getAttribute("aria-checked")).toBe("true");
    click(box("Select Ada"));
    expect(count()).toBe("1 selected");
    click(button("Clear selection"));
    expect(count()).toBe("0 selected");
  });

  it("supports keyboard selection without opening the row", () => {
    render();
    const checkbox = box("Select Ada");
    act(() => {
      checkbox.focus();
      checkbox.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
      checkbox.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
    });
    expect(document.activeElement).toBe(checkbox);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(count()).toBe("1 selected");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects only loaded supported rows, does not auto-select appended pages, and toggles all off", () => {
    const unknown = { kind: "future", id: "new-kind", name: "Future" } as unknown as BrainRow;
    render({ rows: [person, fallback, unknown], completedTasks: [task] });
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    click(all());
    expect(count()).toBe("1 selected");
    render({ rows: [person, company, fallback, unknown], completedTasks: [task] });
    expect(count()).toBe("1 selected");
    expect(all().getAttribute("aria-checked")).toBe("mixed");
    click(all());
    expect(count()).toBe("2 selected");
    click(all());
    expect(count()).toBe("0 selected");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("includes shown completed tasks, preserves opening, and permanently prunes when hidden", () => {
    render({ completedTasks: [task], showCompletedTasks: true });
    click(all());
    expect(count()).toBe("3 selected");
    click(button("Finished"));
    expect(onSelect).toHaveBeenCalledWith(task);
    render({ completedTasks: [task], showCompletedTasks: false });
    expect(count()).toBe("2 selected");
    render({ completedTasks: [task], showCompletedTasks: true });
    expect(box("Select Finished").getAttribute("aria-checked")).toBe("false");
    expect(count()).toBe("2 selected");
  });

  it("prunes removed/filtered rows without resurrecting them and resets across workspaces", () => {
    render();
    click(all());
    render({ rows: [company] });
    expect(count()).toBe("1 selected");
    render();
    expect(box("Select Ada").getAttribute("aria-checked")).toBe("false");
    workspace.activeId = "workspace-b";
    render();
    expect(count()).toBe("0 selected");
    workspace.activeId = "workspace-a";
    render();
    expect(count()).toBe("0 selected");
    click(all());
    render({ rows: [] });
    expect(count()).toBe("0 selected");
    expect(all().getAttribute("aria-disabled") === "true" || all().hasAttribute("disabled")).toBe(true);
    expect(button("Clear selection").disabled).toBe(true);
  });

  it("supports a completed-only list and disables select-all for fallback-only content", () => {
    render({ rows: [], completedTasks: [task], showCompletedTasks: true });
    click(all());
    expect(count()).toBe("1 selected");
    render({ rows: [fallback] });
    expect(count()).toBe("0 selected");
    click(all());
    expect(count()).toBe("0 selected");
  });
});


async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
function dialogButton(text: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find((button) => button.textContent === text);
  if (!node) throw new Error(`Missing dialog button ${text}`);
  return node;
}

describe("[COMP:app-web/brain-grouped-view] Bulk mutations", () => {
  it("confirms pending supported rows through the real SDK and emits a scoped refresh", async () => {
    const refresh = vi.fn();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    const pending: BrainRow[] = [
      { ...person, hasPending: true },
      { kind: "people", id: "crm/person", name: "CRM", hasPending: true },
      { kind: "companies", id: "crm-company", name: "Company", hasPending: true },
      { kind: "deals", id: "crm-deal", name: "Deal", hasPending: true },
      { kind: "memories", id: "memory", name: "Memory", hasPending: true },
      { kind: "files", id: "file", name: "File", hasPending: true },
      { ...task, hasPending: true },
      { kind: "knowledge", id: "knowledge", name: "Knowledge", hasPending: true },
      { kind: "sessions", id: "session", name: "Session", hasPending: true },
      { ...company, id: "verified" }, fallback,
    ];
    render({ rows: pending });
    click(all());
    click(button("Confirm (7)"));
    await settle();
    expect(authFetch.mock.calls.map(([url]) => new URL(url, "http://localhost").pathname)).toEqual([
      "/api/brain-inbox/workspace-a/entity/shared%3Aid/verify",
      "/api/brain-inbox/workspace-a/contact/crm%2Fperson/verify",
      "/api/brain-inbox/workspace-a/company/crm-company/verify",
      "/api/brain-inbox/workspace-a/deal/crm-deal/verify",
      "/api/brain-inbox/workspace-a/memory/memory/verify",
      "/api/brain-inbox/workspace-a/workspace_file/file/verify",
      "/api/brain-inbox/workspace-a/task/done/verify",
    ]);
    expect(authFetch.mock.calls.every(([, options]) => options.method === "POST" && options.body === "{}")).toBe(true);
    expect(count()).toBe("3 selected");
    expect(container.textContent).toContain("7 succeeded; 0 failed");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0][0] as CustomEvent).detail).toEqual({ workspaceId: "workspace-a" });
    window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
  });

  it("shows eligible/selected scope in the project dialog; cancellation sends nothing", async () => {
    render({ rows: [person, { kind: "sessions", id: "s", name: "Session" }] });
    click(all());
    click(button("Delete (1)"));
    await settle();
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Delete 1 of 2 selected loaded rows?");
    expect(authFetch).not.toHaveBeenCalled();
    expect(button("Clear selection").disabled).toBe(true);
    click(dialogButton(en.memoriesReview.cancel));
    await settle();
    expect(authFetch).not.toHaveBeenCalled();
    expect(count()).toBe("2 selected");
    expect(button("Delete (1)").disabled).toBe(false);
  });

  it("deletes exact typed identities without reasons or rules, coalescing entity aliases", async () => {
    render({ rows: [person, { ...person, kind: "people", name: "Alias" }, { ...task, id: person.id }] });
    click(all());
    click(button("Delete (3)"));
    await settle();
    click(dialogButton(en.memoriesReview.deleteConfirmAction));
    await settle();
    expect(authFetch.mock.calls.map(([url]) => new URL(url, "http://localhost").pathname)).toEqual([
      "/api/brain-inbox/workspace-a/entity/shared%3Aid",
      "/api/brain-inbox/workspace-a/task/shared%3Aid",
    ]);
    expect(authFetch.mock.calls.map(([, options]) => options)).toEqual([{ method: "DELETE" }, { method: "DELETE" }]);
    expect(count()).toBe("0 selected");
    expect(container.textContent).toContain("3 succeeded; 0 failed");
  });

  it("reports HTTP and network failures honestly, retains failures and retries only those", async () => {
    authFetch.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "denied" }) }).mockRejectedValueOnce(new Error("offline"));
    render({ rows: [{ ...person, hasPending: true }, { ...task, hasPending: true }, { kind: "files", id: "file", name: "File", hasPending: true }] });
    click(all());
    click(button("Confirm (3)"));
    await settle();
    expect(container.textContent).toContain("1 succeeded; 2 failed");
    expect(count()).toBe("2 selected");
    expect(box("Select Ada").getAttribute("aria-checked")).toBe("false");
    click(button("Confirm (2)"));
    await settle();
    expect(authFetch).toHaveBeenCalledTimes(5);
    expect(count()).toBe("0 selected");
  });

  it("locks actions and selection during requests and prevents double submission", async () => {
    let resolve!: (value: unknown) => void;
    authFetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render({ rows: [{ ...person, hasPending: true }], completedTasks: [task] });
    click(all());
    const confirm = button("Confirm (1)");
    act(() => { confirm.click(); confirm.click(); });
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(button("Delete (1)").disabled).toBe(true);
    expect(button("Ada").disabled).toBe(true);
    expect(button("Show completed").disabled).toBe(true);
    click(all());
    click(box("Select Ada"));
    expect(count()).toBe("1 selected");
    await act(async () => resolve({ ok: true }));
    expect(count()).toBe("0 selected");
  });

  it("does not mutate after a workspace switch while confirming deletion", async () => {
    render(); click(all()); click(button("Delete (2)")); await settle();
    workspace.activeId = "workspace-b";
    render();
    click(dialogButton(en.memoriesReview.deleteConfirmAction));
    await settle();
    expect(authFetch).not.toHaveBeenCalled();
    expect(count()).toBe("0 selected");
  });
  it("retains failed deletions and emits no refresh when every deletion fails", async () => {
    const refresh = vi.fn();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    authFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "denied" }) });
    render({ rows: [person, task] });
    click(all()); click(button("Delete (2)")); await settle();
    click(dialogButton(en.memoriesReview.deleteConfirmAction)); await settle();
    expect(count()).toBe("2 selected");
    expect(container.textContent).toContain("0 succeeded; 2 failed");
    expect(refresh).not.toHaveBeenCalled();
    authFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    click(button("Delete (2)")); await settle();
    click(dialogButton(en.memoriesReview.deleteConfirmAction)); await settle();
    expect(count()).toBe("1 selected");
    expect(container.textContent).toContain("1 succeeded; 1 failed");
    expect(box("Select Finished").getAttribute("aria-checked")).toBe("true");
    expect(refresh).toHaveBeenCalledTimes(1);
    window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
  });

  it("keeps unsupported-only actions disabled", () => {
    render({ rows: [{ kind: "knowledge", id: "k", name: "Knowledge", hasPending: true }, { kind: "sessions", id: "s", name: "Session", hasPending: true }] });
    click(all());
    expect(button("Confirm (0)").disabled).toBe(true);
    expect(button("Delete (0)").disabled).toBe(true);
    click(button("Confirm (0)")); click(button("Delete (0)"));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("uses entity APIs for all singular entity kinds, never graph name matches", async () => {
    const kinds = ["person", "company", "deal", "project", "product", "repository", "other"] as const;
    render({ rows: kinds.map((kind) => ({ kind, id: kind, name: "Same name", hasPending: true })) });
    click(all()); click(button("Confirm (7)")); await settle();
    expect(authFetch.mock.calls.map(([url]) => new URL(url, "http://localhost").pathname)).toEqual(
      kinds.map((kind) => `/api/brain-inbox/workspace-a/entity/${kind}/verify`),
    );
    expect(count()).toBe("0 selected");
  });

  it("keeps an in-flight mutation scoped to its original workspace", async () => {
    let resolve!: (value: unknown) => void;
    authFetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = vi.fn();
    window.addEventListener(BRAIN_REFRESH_EVENT, refresh);
    render({ rows: [{ ...person, hasPending: true }] });
    click(all()); click(button("Confirm (1)"));
    workspace.activeId = "workspace-b";
    render({ rows: [{ ...person, hasPending: true }] });
    await act(async () => resolve({ ok: true }));
    expect(count()).toBe("0 selected");
    expect(container.textContent).not.toContain("1 succeeded");
    expect((refresh.mock.calls[0][0] as CustomEvent).detail.workspaceId).toBe("workspace-a");
    expect(authFetch.mock.calls[0][0]).toContain("/workspace-a/entity/");
    window.removeEventListener(BRAIN_REFRESH_EVENT, refresh);
  });

});
