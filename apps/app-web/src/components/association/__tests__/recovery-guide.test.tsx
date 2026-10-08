// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { AssociationRecoveryGuide } from "../recovery-guide";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(canManage = true, workspaceId = "fictional-workspace") {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><AssociationRecoveryGuide workspaceId={workspaceId} canManage={canManage} /></I18nProvider>));
}
async function review() { await act(async () => (host.querySelector('[role="checkbox"]') as HTMLButtonElement).click()); }
const links = () => [...host.querySelectorAll("a")].map(a => a.getAttribute("href"));
describe("[COMP:app-web/association-recovery] safe independent fresh-start navigation", () => {
  it("does not infer hidden history or dispatch an operation and requires review before fresh navigation", async () => {
    await render();
    expect(host.querySelector("details")?.open).toBe(false);
    expect(host.textContent).toContain(en.associationPage.recovery.uncertain);
    expect(links()).toEqual(["/w/fictional-workspace/association?section=contacts", "/w/fictional-workspace/association?section=admin&tab=sync"]);
    expect(host.querySelector("[data-recovery-fresh-start]")).toBeNull();
    await review();
    expect(links()).toContain("/w/fictional-workspace/association?section=memberships&new=1");
    expect(links()).toContain("/w/fictional-workspace/association?section=payments&new=1");
    expect(host.querySelector("form")).toBeNull();
    await review();
    expect(host.querySelector("[data-recovery-fresh-start]")).toBeNull();
  });
  it("gives members inspection guidance without manager controls", async () => {
    await render(false);
    expect(links()).toEqual(["/w/fictional-workspace/association?section=contacts"]);
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    expect(host.textContent).toContain(en.associationPage.recovery.history);
  });
  it("drops acknowledgement on authority loss and workspace changes", async () => {
    await render(); await review();
    await render(false); await render(true);
    expect(host.querySelector("[data-recovery-fresh-start]")).toBeNull();
    await review(); await render(true, "other-workspace");
    expect(host.querySelector("[data-recovery-fresh-start]")).toBeNull();
    expect(links().every(link => link?.startsWith("/w/other-workspace/"))).toBe(true);
  });
});
