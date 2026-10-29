// @vitest-environment jsdom

import { act } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { SettingsModal, type SettingsSection } from "../settings-modal";
import type { SettingsMemberTarget } from '@/lib/workspace-settings-events';
import { resetSurfaceCache } from '@/lib/surface-cache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

const edition = vi.hoisted(() => ({ teammateManagement: true, billing: true }));

vi.mock("@/lib/edition", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/edition")>(),
  isOssEdition: () => !edition.teammateManagement,
  deploymentCapabilities: () => ({ teammateManagement: edition.teammateManagement, billing: edition.billing }),
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
vi.mock("../sections/token-usage-section", () => ({ TokenUsageSection: () => <h2>Token usage</h2> }));
vi.mock("../sections/account-section", () => ({ AccountSection: () => <h2>Profile</h2> }));
vi.mock("../sections/general-section", () => ({ GeneralSection: () => <h2>Preferences</h2> }));
vi.mock("../sections/privacy-section", () => ({ PrivacySection: () => <>
  <h2>Privacy</h2>
  <Dialog.Root>
    <Dialog.Trigger>Manage archive</Dialog.Trigger>
    <Dialog.Portal><Dialog.Backdrop /><Dialog.Popup aria-label="Archived chats">
      <Dialog.Close>Close archive</Dialog.Close>
    </Dialog.Popup></Dialog.Portal>
  </Dialog.Root>
</> }));
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
  edition.billing = true;
  resetSurfaceCache();
  onClose.mockClear();
  navigation.push.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(open = true, initialSection: SettingsSection = "profile", initialMemberTarget?:SettingsMemberTarget) {
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
  it("redirects legacy Projects settings to the workspace Projects browser", async () => {
    await render(true, "ws-projects");
    expect(navigation.push).toHaveBeenCalledWith("/w/workspace-1/projects");
    expect(onClose).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    ['ws-organization', '/w/workspace-1/organization'],
    ['ws-teams', '/w/workspace-1/organization?section=departments'],
    ['ws-access', '/w/workspace-1/organization?section=access'],
    ['ws-members', '/w/workspace-1/organization?section=people'],
  ] as const)('redirects %s to its single Organization home', async (section, href) => {
    await render(true, section); expect(navigation.push).toHaveBeenCalledWith(href); expect(onClose).toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('preserves a selected person only within the originating workspace', async () => {
    await render(true, 'ws-members', {workspaceId:'workspace-1', memberId:'user-2'});
    expect(navigation.push).toHaveBeenLastCalledWith('/w/workspace-1/organization?section=people&member=user-2');
    await render(true, 'ws-members', {workspaceId:'another-workspace', memberId:'user-2'});
    expect(navigation.push).toHaveBeenLastCalledWith('/w/workspace-1/organization');
  });
  it('opens Organization from the compact Settings picker', async () => {
    await render(); await choose(en.organization.title);
    expect(navigation.push).toHaveBeenCalledWith('/w/workspace-1/organization'); expect(onClose).toHaveBeenCalled();
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
    expectVisible(document.querySelector("h2"));
    expect(picker().textContent).toContain(en.chrome.settingsModal.account.profile);
  });

  it("dismisses the open picker with Escape before closing settings", async () => {
    await render();
    await act(async () => picker().click());
    expect(picker().getAttribute("aria-expanded")).toBe("true");
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(picker().getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
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


describe("[COMP:app-web/settings-modal] Outpost usage navigation", () => {
  it("opens standalone usage rather than the hosted alias in both rails", async () => {
    edition.billing = false;
    await render(true, "ws-usage");
    expect(document.querySelector("h2")?.textContent).toBe("Token usage");
    expect(picker().textContent).toContain(en.chrome.settingsModal.workspace.usage);
    const nav = document.querySelector("nav")!;
    expect(nav.textContent).toContain(en.chrome.settingsModal.workspace.usage);
    expect(nav.textContent).not.toContain(en.chrome.settingsModal.workspace.plan);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe(en.chrome.settingsModal.workspace.usage);
  });
});


// Use real Base UI focus ownership. The browser replay separately exercises
// physical Tab traversal; jsdom models the tab-order boundaries via its guards.
describe("[COMP:app-web/settings-modal] modal keyboard ownership", () => {
  let opener: HTMLButtonElement;
  let mobileMenu: HTMLButtonElement;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) {
        if (getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") return [] as unknown as DOMRectList;
      }
      return [new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList;
    });
    opener = document.createElement("button"); opener.textContent = "Account"; document.body.append(opener);
    mobileMenu = document.createElement("button"); mobileMenu.dataset.docMobileMenu = ""; mobileMenu.textContent = "Open sidebar"; document.body.append(mobileMenu);
    opener.focus();
  });
  afterEach(() => { opener.remove(); mobileMenu.remove(); vi.restoreAllMocks(); });
  const settle = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); }); };
  const settings = () => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${en.chrome.settingsModal.title}"]`)!;
  const close = () => settings().querySelector<HTMLButtonElement>(`button[aria-label="${en.chrome.settingsModal.close}"]`)!;

  it("focuses a visible non-input control and excludes the background", async () => {
    await render(); await settle();
    expect(settings().getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(close());
    expect(opener.closest('[aria-hidden="true"], [inert]')).not.toBeNull();
    expectVisible(document.activeElement);
  });

  it("keeps both tab-order boundaries inside Settings and restores the opener", async () => {
    await render(); await settle();
    const guards = [...document.querySelectorAll<HTMLElement>('[data-base-ui-focus-guard]')];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    for (const guard of [guards[0], guards[guards.length - 1]]) {
      await act(async () => guard.focus()); await settle();
      expect(settings().contains(document.activeElement)).toBe(true);
    }
    await render(false); await settle();
    expect(document.activeElement).toBe(opener);
  });

  it("restores the mobile menu when the drawer opener is hidden", async () => {
    await render(); await settle();
    opener.style.visibility = "hidden";
    await render(false); await settle();
    expect(document.activeElement).toBe(mobileMenu);
  });

  it("dismisses a nested dialog before Settings and returns to its trigger", async () => {
    await render(true, "privacy"); await settle();
    const manage = [...settings().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Manage archive")!;
    await act(async () => manage.click()); await settle();
    const nested = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Archived chats"]')!;
    expect(nested.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))); await settle();
    expect(document.querySelector('[aria-label="Archived chats"][role="dialog"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(manage);
    await act(async () => manage.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not restore the opener over a navigated destination", async () => {
    const destination = document.createElement("button"); destination.textContent = "Project destination"; document.body.append(destination);
    try {
      await render(); await settle();
      await render(true, "ws-projects"); destination.focus(); await settle();
      expect(navigation.push).toHaveBeenCalledWith("/w/workspace-1/projects");
      expect(document.activeElement).toBe(destination);
    } finally { destination.remove(); }
  });
});
