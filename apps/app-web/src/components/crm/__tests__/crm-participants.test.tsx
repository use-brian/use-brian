// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listCrmDealParticipants: vi.fn(), addCrmDealParticipant: vi.fn(), removeCrmDealParticipant: vi.fn() }));
vi.mock("@/lib/api/crm", () => api);
vi.mock("../crm-cells", () => ({ TextFieldCell: ({ value }: { value: string }) => <span>{value}</span> }));
import { CrmParticipants } from "../crm-participants";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const first = { contactId: "person-a", name: "First participant", email: "first@example.test", role: "Reviewer", isPrimary: true };
const second = { contactId: "person-b", name: "Second participant", email: "second@example.test", role: null, isPrimary: false };
const contacts = [{ id: "candidate", name: "Candidate contact", email: null, phone: null, companyId: null, tags: [], updatedAt: "2026-01-01T00:00:00Z" }];
const denied = "This relationship is unavailable for this operation. Ask a workspace administrator to review access.";
const changed = vi.fn();
let root: Root, host: HTMLDivElement;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }
async function render(workspaceId = "workspace-a", dealId = "deal-a", initialParticipants = [first]) {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><CrmParticipants workspaceId={workspaceId} dealId={dealId} initialParticipants={initialParticipants} contacts={contacts} onChanged={changed} /></I18nProvider>));
  await settle();
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  await settle();
}
beforeEach(() => {
  vi.resetAllMocks();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  api.listCrmDealParticipants.mockResolvedValue([first]);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("[COMP:app-web/crm-participants] scoped participant recovery", () => {
  it("evicts initial metadata on a failed refresh and offers an authorized retry", async () => {
    const pending = deferred<typeof first[]>();
    api.listCrmDealParticipants.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([first]);
    await render();
    await click(en.crmPage.r2.addParticipant);
    expect(host.textContent).toContain(en.crmPage.r2.pickContact);
    await act(async () => pending.reject(new Error(denied))); await settle();
    expect(host.textContent).not.toContain(first.name);
    expect(host.textContent).not.toContain(first.email);
    expect(host.textContent).not.toContain(first.role);
    expect(host.textContent).toContain(denied);
    expect(host.textContent).not.toContain(en.crmPage.r2.pickContact);
    expect(host.textContent).not.toContain(en.crmPage.r2.addParticipant);
    await click(en.crmPage.r2.retry);
    expect(host.textContent).toContain(first.name);
    expect(host.textContent).not.toContain(denied);
    expect(api.listCrmDealParticipants).toHaveBeenLastCalledWith("workspace-a", "deal-a");
  });

  it.each(["workspace", "deal"])("ignores a late load after changing %s", async axis => {
    const pending = deferred<typeof first[]>();
    api.listCrmDealParticipants.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([second]);
    await render();
    await render(axis === "workspace" ? "workspace-b" : "workspace-a", axis === "deal" ? "deal-b" : "deal-a", []);
    await act(async () => pending.resolve([first])); await settle();
    expect(host.textContent).toContain(second.name);
    expect(host.textContent).not.toContain(first.name);
    expect(host.textContent).not.toContain(first.email);
  });

  it("ignores a superseded refresh for the same deal", async () => {
    const pending = deferred<typeof first[]>();
    api.listCrmDealParticipants.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([second]);
    await render();
    await render("workspace-a", "deal-a", []);
    await act(async () => pending.resolve([first])); await settle();
    expect(host.textContent).toContain(second.name);
    expect(host.textContent).not.toContain(first.name);
  });

  it("evicts metadata after a refused removal without reporting success or retrying the mutation", async () => {
    await render();
    api.removeCrmDealParticipant.mockRejectedValueOnce(new Error(denied));
    await click(en.crmPage.r2.removeParticipant);
    expect(host.textContent).toContain(denied);
    expect(host.textContent).not.toContain(first.name);
    expect(host.textContent).not.toContain(first.email);
    expect(changed).not.toHaveBeenCalled();
    api.listCrmDealParticipants.mockResolvedValueOnce([]);
    await click(en.crmPage.r2.retry);
    expect(api.removeCrmDealParticipant).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(en.crmPage.r2.noParticipants);
  });

  it("does not refresh or notify a different deal after an old mutation finishes", async () => {
    await render();
    const pending = deferred<void>();
    api.removeCrmDealParticipant.mockReturnValueOnce(pending.promise);
    await click(en.crmPage.r2.removeParticipant);
    api.listCrmDealParticipants.mockResolvedValueOnce([second]);
    await render("workspace-a", "deal-b", []);
    await act(async () => pending.resolve()); await settle();
    expect(changed).not.toHaveBeenCalled();
    expect(api.listCrmDealParticipants).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(second.name);
    expect(host.textContent).not.toContain(first.name);
  });
});
