// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import ConnectionsPage from "../page";
import CapturePage from "../capture/page";
import type { BrainKeysSnapshot } from "../use-brain-keys-data";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { ProgrammaticAccessShell } from "@/components/studio/programmatic-access-shell";

const mocks = vi.hoisted(() => ({
  workspaceId: "workspace-fixture", data: undefined as BrainKeysSnapshot | undefined,
  adminOnly: false, error: null as string | null, createKey: vi.fn(), createProfile: vi.fn(), addRule: vi.fn(), listProfiles: vi.fn(), refresh: vi.fn(),
}));
vi.mock("@/contexts/workspace-context", () => ({ useWorkspaces: () => ({ activeId: mocks.workspaceId }) }));
vi.mock("../use-brain-keys-data", () => ({ useBrainKeysData: () => ({
  data: mocks.data, adminOnly: mocks.adminOnly, error: mocks.error, refresh: mocks.refresh,
  update: (fn: (data: BrainKeysSnapshot) => BrainKeysSnapshot) => { if (mocks.data) mocks.data = fn(mocks.data); },
}) }));
vi.mock("@/lib/api/brain-keys", async importOriginal => ({ ...await importOriginal<object>(), createBrainKey: mocks.createKey }));
vi.mock("@/lib/api/programmatic-capture", async importOriginal => ({ ...await importOriginal<object>(), createCaptureProfile: mocks.createProfile, addCaptureRule: mocks.addRule, listCaptureProfiles: mocks.listProfiles }));

let host: HTMLDivElement;
let root: Root;
const render = async (node: ReactNode) => { await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>)); };
const click = async (text: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === text);
  expect(button, text).toBeDefined(); await act(async () => button!.click());
};
const fill = async (input: HTMLInputElement, value: string) => { await act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}); };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.workspaceId = "workspace-fixture"; mocks.adminOnly = false; mocks.error = null;
  mocks.data = { keys: [], authorizations: [], teams: [{ id: "department-fixture", key: "team:department-fixture", name: "Engineering", status: "active", description: null, color: null, readAll: false, readGrantGroupIds: [], memberCount: 1 }], projects: [], assistants: [], captureProfiles: [] };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mocks.listProfiles.mockResolvedValue([]); mocks.createProfile.mockResolvedValue({ id: "profile-fixture" }); mocks.addRule.mockResolvedValue({});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/studio-programmatic-access] task navigation and setup", () => {
  it("starts with endpoint and credentials, keeping capture setup out of Connections", async () => {
    await render(<ConnectionsPage />);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe("Connections");
    expect(host.querySelector('a[href$="/capture"]')).not.toBeNull();
    expect(host.querySelector('a[href$="/applications"]')).not.toBeNull();
    expect([...host.querySelectorAll("h2")].map(el => el.textContent)).toEqual([en.programmaticAccess.navigation.endpoint, en.programmaticAccess.keysTitle, en.programmaticAccess.connectedApps.title]);
    expect(host.textContent).not.toContain(en.engineeringHistory.preset);
    expect(host.querySelector("form")).toBeNull();
    await click(en.programmaticAccess.newKey);
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe("Connections");
    await click(en.programmaticAccess.create.cancel);
    expect(host.querySelector("form")).toBeNull();
  });

  it("requires an explicit Department before creating the archive preset", async () => {
    await render(<CapturePage />);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe("Capture");
    expect(host.querySelector('a[href$="/history"]')).not.toBeNull();
    expect(host.querySelector(`input[aria-label="${en.engineeringHistory.name}"]`)).toBeNull();
    await click(en.programmaticAccess.capture.createProfile);
    expect(host.textContent).toContain(en.contextScope.selectDepartment);
    await fill(host.querySelector<HTMLInputElement>(`input[aria-label="${en.engineeringHistory.name}"]`)!, "Archive fixture");
    const create = [...host.querySelectorAll<HTMLButtonElement>("button")].find(el => el.textContent === en.engineeringHistory.create)!;
    expect(create.disabled).toBe(true);
    const department = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.contextScope.team}"]`)!;
    await act(async () => department.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === "Engineering");
    expect(option).toBeDefined(); await act(async () => option!.click());
    expect(create.disabled).toBe(false);
    await click(en.engineeringHistory.create);
    expect(mocks.createProfile).toHaveBeenCalledWith("workspace-fixture", expect.objectContaining({ processingMode: "archive_only", destination: { kind: "department", departmentId: "department-fixture" } }));
    expect(mocks.addRule).toHaveBeenCalledWith("workspace-fixture", "profile-fixture", expect.objectContaining({ compartments: ["team:department-fixture"], scopeBindingMode: "explicit" }));
    expect(host.querySelector(`input[aria-label="${en.engineeringHistory.name}"]`)).toBeNull();
  });

  it("keeps history, setup and recovery accessible when profile administration is denied", async () => {
    mocks.data = undefined; mocks.adminOnly = true;
    await render(<CapturePage />);
    expect(host.textContent).toContain(en.programmaticAccess.navigation.captureAdminOnly);
    expect(host.querySelector('a[href$="/history"]')).not.toBeNull();
    expect(host.textContent).toContain(en.engineeringHistory.pendingRecovery);
    expect(host.textContent).toContain(en.engineeringHistory.setup);
    expect(host.textContent).not.toContain(en.programmaticAccess.capture.createProfile);
  });

  it("does not show an empty profile list or a creation action after loading fails", async () => {
    mocks.data = undefined; mocks.error = "Connection unavailable";
    await render(<CapturePage />);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Connection unavailable");
    expect(host.textContent).not.toContain(en.programmaticAccess.capture.empty);
    expect(host.textContent).not.toContain(en.programmaticAccess.capture.createProfile);
  });

  it("clears a connection creation draft when the workspace changes", async () => {
    await render(<ConnectionsPage />); await click(en.programmaticAccess.newKey);
    await fill(host.querySelector<HTMLInputElement>(`input[placeholder="${en.programmaticAccess.create.placeholder}"]`)!, "Draft fixture");
    mocks.workspaceId = "other-workspace";
    await render(<ConnectionsPage />);
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/w/other-workspace/studio/programmatic-access");
  });

  it("retains the one-time key reveal and clears it on a workspace switch", async () => {
    mocks.createKey.mockResolvedValue({ id: "key-fixture", name: "Laptop fixture", key: "sk_brain_fixture_not_a_real_secret", prefix: "sk_brain_fixture", scope: "read", status: "active", maxClearance: "internal" });
    await render(<ConnectionsPage />); await click(en.programmaticAccess.newKey);
    await fill(host.querySelector<HTMLInputElement>(`input[placeholder="${en.programmaticAccess.create.placeholder}"]`)!, "Laptop fixture");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("sk_brain_fixture_not_a_real_secret");
    expect(host.textContent).toContain(en.programmaticAccess.reveal.bannerHeading);
    expect(host.querySelector('a[aria-current="page"]')?.textContent).toBe(en.programmaticAccess.navigation.connections);
    mocks.workspaceId = "other-workspace";
    await render(<ConnectionsPage />);
    expect(host.textContent).not.toContain("sk_brain_fixture_not_a_real_secret");
  });

  it("shows saved profile summaries with their rule controls collapsed until requested", async () => {
    mocks.data!.captureProfiles = [{ id: "profile-fixture", name: "Archive fixture", processingMode: "archive_only", enabled: true, partitionBy: "session", rules: [], assistantIds: [], workspaceId: "workspace-fixture", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }];
    await render(<CapturePage />);
    const summary = [...host.querySelectorAll("summary")].find(el => el.textContent?.includes("Archive fixture"))!;
    expect(summary).toBeDefined();
    const disclosure = summary.closest("details")!;
    expect(disclosure.open).toBe(false);
    await act(async () => summary.click());
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain(en.programmaticAccess.capture.noRules);
    expect(disclosure.querySelector('button[aria-label="Processing purpose"]')).not.toBeNull();
  });

  for (const [locale, dict] of [["en", en], ["ja", ja], ["zh", zh], ["zh-CN", zhCN]] as const) {
    it(`provides the same three destinations with localized labels in ${locale}`, async () => {
      await act(async () => root.render(<I18nProvider locale={locale} dict={dict}><ProgrammaticAccessShell active="applications"><span /></ProgrammaticAccessShell></I18nProvider>));
      expect([...host.querySelectorAll("nav a")].map(el => el.textContent)).toEqual([dict.programmaticAccess.navigation.connections, dict.programmaticAccess.navigation.capture, dict.programmaticAccess.navigation.applications]);
      expect(host.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/w/workspace-fixture/studio/programmatic-access/applications");
    });
  }
});
