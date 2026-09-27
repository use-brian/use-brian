// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { SettingsModal, type SettingsSection } from "../settings-modal";
import type { SettingsMemberTarget } from '@/lib/workspace-settings-events';
import { resetSurfaceCache } from '@/lib/surface-cache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const edition = vi.hoisted(() => ({ teammateManagement: true }));

vi.mock("@/lib/edition", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/edition")>(),
  isOssEdition: () => !edition.teammateManagement,
  deploymentCapabilities: () => ({ teammateManagement: edition.teammateManagement, billing: edition.teammateManagement }),
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
}));
vi.mock("@/lib/user", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/user")>(),
  getUserInfo: () => ({ id: "user-1" }),
}));
vi.mock("@/lib/auth-fetch", () => ({
  authFetch: vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.endsWith("/invitations")
      ? { invitations: [] }
      : { id: "workspace-1", name: "Example workspace", role: "owner", members: [
        {userId:'user-1',userName:'Riley',role:'owner',email:'riley@example.com'},
        {userId:'user-2',userName:'Casey',role:'member',email:'casey@example.com'},
      ] },
  })),
}));
// Other sections do not participate in invitation loading or navigation.
vi.mock("../sections/account-section", () => ({ AccountSection: () => <h2>Profile</h2> }));
vi.mock("../sections/general-section", () => ({ GeneralSection: () => <h2>Preferences</h2> }));
vi.mock("../sections/privacy-section", () => ({ PrivacySection: () => <h2>Privacy</h2> }));
vi.mock("../sections/models-section", () => ({ ModelsSection: () => <h2>Models</h2> }));
vi.mock("../sections/billing-section", () => ({ BillingSection: () => <h2>Plan &amp; usage</h2> }));
vi.mock("../sections/domains-section", () => ({ DomainsSection: () => <h2>Domains</h2> }));
vi.mock("../sections/context-scopes-section", () => ({
  TeamsContextSection: () => <h2>Teams</h2>,
  ProjectsContextSection: () => <h2>Projects</h2>,
}));

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();

beforeEach(() => {
  edition.teammateManagement = true;
  resetSurfaceCache();
  onClose.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(open = true, initialSection: SettingsSection = "ws-members", initialMemberTarget?:SettingsMemberTarget) {
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en}>
      {/* jsdom does not build Tailwind; supply its base phone visibility rule. */}
      <style>{".hidden { display: none; }"}</style>
      <SettingsModal open={open} initialSection={initialSection} initialMemberTarget={initialMemberTarget} onClose={onClose} />
    </I18nProvider>,
  ));
}

function picker() {
  const trigger = document.querySelector<HTMLButtonElement>(`[role="combobox"][aria-label="${en.chrome.settingsModal.title}"]`);
  expect(trigger).not.toBeNull();
  return trigger!;
}

function expectVisible(element: Element | null) {
  expect(element).not.toBeNull();
  for (let node = element; node; node = node.parentElement) {
    expect(getComputedStyle(node).display).not.toBe("none");
  }
}

async function choose(label: string) {
  await act(async () => picker().click());
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")]
    .find((node) => node.textContent === label);
  expect(option).toBeDefined();
  // The real Select commits only a highlighted mouse option. Model the hover
  // before the click instead of invoking an incomplete programmatic gesture.
  await act(async () => option!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  await act(async () => option!.click());
}

describe("[COMP:app-web/settings-modal] mobile section navigation", () => {
  it('opens the exact selected person and offers a path back to the full roster',async()=>{
    await render(true,'ws-members',{workspaceId:'workspace-1',memberId:'user-2'});
    expect(document.body.textContent).toContain('Casey');expect(document.body.textContent).not.toContain('Riley');
    expect(document.querySelector('textarea')).toBeNull();
    const showAll=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===en.organization.showAllMembers)!;
    await act(async()=>showAll.click());
    expect(document.body.textContent).toContain('Riley');expect(document.querySelector('textarea')).not.toBeNull();
  });
  it('shows read-only focused person details in self-hosted without management controls',async()=>{
    edition.teammateManagement=false;
    await render(true,'ws-members',{workspaceId:'workspace-1',memberId:'user-2'});
    expect(document.querySelector('h2')?.textContent).toBe(en.organization.memberDetails);
    expect(document.body.textContent).toContain('Casey');
    expect(document.body.textContent).not.toContain('Riley');
    expect(document.querySelector('textarea')).toBeNull();
    expect([...document.querySelectorAll('button')].some(b=>b.textContent===en.organization.showAllMembers)).toBe(false);
    expect([...document.querySelectorAll('button')].some(b=>b.textContent===en.workspaceAccess.organization)).toBe(true);
  });
  it.each([
    {workspaceId:'workspace-1',memberId:'missing'},
    {workspaceId:'another-workspace',memberId:'user-2'},
  ])('never substitutes another person for an unavailable scoped target',async target=>{
    await render(true,'ws-members',target);
    expect(document.body.textContent).toContain(en.organization.memberUnavailable);
    expect(document.body.textContent).not.toContain('Casey');expect(document.body.textContent).not.toContain('Riley');
  });
  it('updates the selected person while settings remain open',async()=>{
    await render(true,'ws-members',{workspaceId:'workspace-1',memberId:'user-2'});
    expect(document.body.textContent).toContain('Casey');
    await render(true,'ws-members',{workspaceId:'workspace-1',memberId:'user-1'});
    expect(document.body.textContent).toContain('Riley');expect(document.body.textContent).not.toContain('Casey');
  });
  it("shows the invite form immediately when opened at Members", async () => {
    await render(false);
    await render();
    expectVisible(document.querySelector(`textarea[placeholder="${en.workspaceDetailInline.inviteEmailsPlaceholder}"]`));
    expect(picker().textContent).toContain(en.chrome.settingsModal.workspace.members);
    expect(picker().getAttribute("aria-expanded")).toBe("false");
  });

  it("switches sections through the compact picker and resets on reopening", async () => {
    await render();
    await choose(en.chrome.settingsModal.account.notifications);
    expectVisible(document.querySelector("h2"));
    expect(document.querySelector("h2")?.textContent).toBe(en.chrome.settingsModal.account.notifications);
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    await render(false);
    await render();
    expectVisible(document.querySelector("textarea"));
    expect(picker().textContent).toContain(en.chrome.settingsModal.workspace.members);
  });

  it("dismisses the open picker with Escape before closing settings", async () => {
    await render();
    await act(async () => picker().click());
    expect(picker().getAttribute("aria-expanded")).toBe("true");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps new deep links and legacy aliases aligned with the picker", async () => {
    await render();
    for (const [section, label] of [
      ["ws-llm-key", en.chrome.settingsModal.workspace.models],
      ["ws-usage", en.chrome.settingsModal.workspace.plan],
      ["profile", en.chrome.settingsModal.account.profile],
    ] as const) {
      await render(true, section);
      expect(picker().textContent).toContain(label);
      expect(document.querySelector("h2")?.textContent).toBe(label);
      expectVisible(document.querySelector("h2"));
    }
  });
});
