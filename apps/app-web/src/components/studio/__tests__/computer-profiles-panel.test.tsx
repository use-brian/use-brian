// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { updateComputerProfileAssistant } from "@/lib/api/computer-profiles";
import { authFetch } from "@/lib/auth-fetch";
import { ComputerProfilesPanel } from "../computer-profiles-panel";
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.test" }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: ({ checked, onCheckedChange, ...props }: any) => <input type="checkbox" checked={checked} onChange={e => onCheckedChange(e.target.checked)} {...props} /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let el: HTMLDivElement; let root: Root;
let profile: { id: string; workspaceId: string; name: string; enabledAssistantIds: string[]; assistantRoutingNotes: Record<string, string>; deviceId: string | null; connected: boolean; canManage: boolean };
beforeEach(() => {
  el = document.createElement("div"); root = createRoot(el);
  profile = { id: "p", workspaceId: "w", name: "My Mac", enabledAssistantIds: ["other"], assistantRoutingNotes: { other: "Preserve" }, deviceId: null, connected: true, canManage: true };
  vi.mocked(authFetch).mockImplementation(async (_url, init) => {
    if (init?.method === "PATCH") {
      const assistantId = decodeURIComponent(String(_url).split("/assistants/")[1]);
      const patch = JSON.parse(init.body as string);
      expect(Object.keys(patch).every(key => ["enabled", "routingNote"].includes(key))).toBe(true);
      if (patch.enabled !== undefined) profile = { ...profile, enabledAssistantIds: patch.enabled
        ? [...new Set([...profile.enabledAssistantIds, assistantId])]
        : profile.enabledAssistantIds.filter(id => id !== assistantId) };
      if (patch.routingNote !== undefined) profile = { ...profile, assistantRoutingNotes: { ...profile.assistantRoutingNotes, [assistantId]: patch.routingNote } };
      return new Response(JSON.stringify({ profile }));
    }
    return new Response(JSON.stringify({ profiles: [profile, { ...profile, id: "private", name: "Not manageable", canManage: false }] }));
  });
});
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); });
async function render(workspaceId = "w", assistantId = "a") { await act(async () => root.render(<ComputerProfilesPanel workspaceId={workspaceId} assistantId={assistantId} />)); }
it("[COMP:app-web/computer-profiles] grants/revokes only this assistant and explains capability requirement", async () => {
  await render();
  expect(el.textContent).toContain(en.computerProfiles.capabilityHelp);
  expect(el.textContent).toContain(en.computerProfiles.online);
  expect(el.textContent).not.toContain("Not manageable");
  await act(async () => el.querySelector("input")!.click());
  expect(profile.enabledAssistantIds).toEqual(["other", "a"]);
  expect((el.querySelector("input") as HTMLInputElement).checked).toBe(true);
  await act(async () => el.querySelector("input")!.click());
  expect(profile.enabledAssistantIds).toEqual(["other"]);
  expect(profile.assistantRoutingNotes).toEqual({ other: "Preserve" });
});
it("[COMP:app-web/computer-profiles] saves optional routing notes without overwriting another assistant", async () => {
  await render();
  await act(async () => {
    const textarea = el.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Use for design");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => el.querySelector("button")!.click());
  expect(profile.assistantRoutingNotes).toEqual({ other: "Preserve", a: "Use for design" });
});
it("[COMP:app-web/computer-profiles] failed grants stay off with a visible error", async () => {
  await render(); vi.mocked(authFetch).mockResolvedValueOnce(new Response("{}", { status: 403 }));
  await act(async () => el.querySelector("input")!.click());
  expect((el.querySelector("input") as HTMLInputElement).checked).toBe(false);
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(en.computerProfiles.errors.computer_profiles_forbidden);
});
it("[COMP:app-web/computer-profiles] an old grant response cannot restore the previous workspace", async () => {
  await render();
  let resolve!: (value: Response) => void;
  vi.mocked(authFetch).mockReturnValueOnce(new Promise<Response>(r => { resolve = r; }));
  await act(async () => el.querySelector("input")!.click());
  await render("other");
  await act(async () => resolve(new Response(JSON.stringify({ profile }))));
  expect(el.textContent).not.toContain("My Mac");
  expect(el.querySelector("input")).toBeNull();
});
it("[COMP:app-web/computer-profiles] exposes an explicit capability switch independently of profile grants", async () => {
  const changeCapability = vi.fn().mockResolvedValue(true);
  await act(async () => root.render(<ComputerProfilesPanel workspaceId="w" assistantId="a" capability={{ enabled: false, pending: false, onChange: changeCapability }} />));
  expect(changeCapability).not.toHaveBeenCalled();
  const capabilitySwitch = el.querySelector<HTMLInputElement>(`input[aria-label="${en.computerProfiles.capabilityToggle}"]`)!;
  const profileSwitch = el.querySelector<HTMLInputElement>(`input[aria-label="${en.computerProfiles.available}: My Mac"]`)!;
  expect(capabilitySwitch.checked).toBe(false);
  await act(async () => profileSwitch.click());
  expect(profile.enabledAssistantIds).toContain("a");
  expect(changeCapability).not.toHaveBeenCalled();
  expect(capabilitySwitch.checked).toBe(false);
  await act(async () => capabilitySwitch.click());
  expect(changeCapability).toHaveBeenCalledExactlyOnceWith(true);
  // No optimistic grant is fabricated by the panel; the parent's server read owns it.
  expect(capabilitySwitch.checked).toBe(false);
});
it("[COMP:app-web/computer-profiles] reports capability denial without enabling it", async () => {
  const changeCapability = vi.fn().mockResolvedValue(false);
  await act(async () => root.render(<ComputerProfilesPanel workspaceId="w" assistantId="a" capability={{ enabled: false, pending: false, onChange: changeCapability }} />));
  await act(async () => el.querySelector<HTMLInputElement>(`input[aria-label="${en.computerProfiles.capabilityToggle}"]`)!.click());
  expect(el.textContent).toContain(en.computerProfiles.capabilityError);
  expect(el.querySelector<HTMLInputElement>(`input[aria-label="${en.computerProfiles.capabilityToggle}"]`)!.checked).toBe(false);
});
it("[COMP:app-web/computer-profiles] offers navigation to capability settings if the grant is unavailable", async () => {
  const manage = vi.fn();
  await act(async () => root.render(<ComputerProfilesPanel workspaceId="w" assistantId="a" onManageCapability={manage} />));
  await act(async () => Array.from(el.querySelectorAll("button")).find(button => button.textContent === en.computerProfiles.manageCapability)!.click());
  expect(manage).toHaveBeenCalledOnce();
  expect(vi.mocked(authFetch).mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
});
it("[COMP:app-web/computer-profiles] enabling B from a stale list never regrants revoked A", async () => {
  await render("w", "b"); // UI sees A ('other') enabled.
  await updateComputerProfileAssistant("p", "other", { enabled: false });
  expect(profile.enabledAssistantIds).toEqual([]);
  await act(async () => el.querySelector("input")!.click());
  expect(profile.enabledAssistantIds).toEqual(["b"]);
  expect(authFetch).toHaveBeenCalledWith("https://api.test/api/native-computer/profiles/p/assistants/b", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: true }) }));
});
it("[COMP:app-web/computer-profiles] editing B's note never restores A's old routing note", async () => {
  await render("w", "b");
  await updateComputerProfileAssistant("p", "other", { routingNote: "Changed elsewhere" });
  await act(async () => {
    const textarea = el.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "B's note");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => el.querySelector("button")!.click());
  expect(profile.assistantRoutingNotes).toEqual({ other: "Changed elsewhere", b: "B's note" });
  expect(authFetch).toHaveBeenCalledWith("https://api.test/api/native-computer/profiles/p/assistants/b", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ routingNote: "B's note" }) }));
});
