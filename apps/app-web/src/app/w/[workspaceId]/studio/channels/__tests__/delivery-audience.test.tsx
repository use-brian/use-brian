// @vitest-environment jsdom
/** [COMP:app-web/channel-delivery-audiences] Delivery audience approval boundaries. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ChannelConfigUpdateError, updateChannelConfig, type Channel, type DeliveryAudienceBinding } from "@/lib/api/channels";
import { listContextProjects } from "@/lib/api/context-scopes";
import { listChannelDestinations, listWorkspaceMemberOptions } from "@/lib/api/workflow";
import type { ConfirmOptions } from "@/components/ui/confirm-dialog";
import { DeliveryAudienceSection } from "../delivery-audience-section";

const confirmDialog = vi.hoisted(() => vi.fn(async (_options: ConfirmOptions) => true));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog }));
vi.mock("@/lib/api/channels", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api/channels")>(),
  updateChannelConfig: vi.fn(),
}));
vi.mock("@/lib/api/context-scopes", () => ({ listContextProjects: vi.fn() }));
vi.mock("@/lib/api/workflow", () => ({ listChannelDestinations: vi.fn(), listWorkspaceMemberOptions: vi.fn() }));
vi.mock("@/lib/api/departments", () => ({ fetchDepartments: vi.fn(async () => ({ homes: [], departments: [
  { departmentId: "dept-finance", name: "Finance", status: "active", revision: 1, myClearance: "internal", isOwner: false, ownerIds: [] },
  { departmentId: "dept-ops", name: "Ops", status: "active", revision: 1, myClearance: "confidential", isOwner: true, ownerIds: [] },
  { departmentId: "dept-board", name: "Board", status: "active", revision: 1, myClearance: null, isOwner: false, ownerIds: [] },
] })) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = en.studioPage.channels.deliveryAudience;
const project = "12345678-1234-1234-1234-123456789abc";
const recipient = "abcdefab-1234-1234-1234-123456789abc";
const first: DeliveryAudienceBinding = {
  channelId: "-100111", audienceType: "group", clearance: "internal",
  compartments: ["team:dept-finance"], projectIds: [project], recipientUserId: null,
  expiresAt: "2099-01-01T00:00:00.000Z", version: 1,
  approvedByUserId: recipient, approvedAt: "2026-01-01T00:00:00.000Z",
};
const second: DeliveryAudienceBinding = { ...first, channelId: "42", audienceType: "individual", recipientUserId: recipient };
function input(binding: DeliveryAudienceBinding) {
  const { version: _version, approvedByUserId: _by, approvedAt: _at, ...result } = binding;
  return result;
}
function channel(bindings = [first, second]): Channel {
  return {
    id: "channel_1", workspaceId: "workspace_1", channelType: "telegram", integrationId: "integration_1",
    clearance: "internal", enabledCapabilities: ["chat"], status: "active",
    displayName: "Bot", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    config: { deliveryAudienceBindings: bindings },
  };
}
let host: HTMLDivElement;
let root: Root;
const onUpdated = vi.fn();
async function render(value = channel(), canManage = true) {
  await act(async () => root.render(
    <I18nProvider locale="en" dict={en}>
      <DeliveryAudienceSection workspaceId="workspace_1" channel={value} canManage={canManage} onUpdated={onUpdated} />
    </I18nProvider>,
  ));
}
function button(text: string, within: ParentNode = host) {
  const result = [...within.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  expect(result, `button ${text}`).toBeDefined();
  return result!;
}
async function click(text: string, within: ParentNode = host) {
  await act(async () => button(text, within).click());
}
function field(key: string) {
  const result = host.querySelector<HTMLInputElement>(`input[id$="-${key}"]`);
  expect(result, `field ${key}`).not.toBeNull();
  return result!;
}
async function fill(key: string, value: string) {
  await act(async () => {
    const node = field(key);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
// Exercise the actual Base UI Select, including its portalled options.
async function select(index: number, text: string) {
  await act(async () => (host.querySelectorAll<HTMLButtonElement>('[role="combobox"][aria-labelledby]')[index]).click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.trim() === text);
  expect(option, `option ${text}`).toBeDefined();
  await act(async () => option!.click());
}
async function add() { await click(copy.add); await fill("channelId", "-100333"); }
function expectWrite(bindings: unknown[]) {
  expect(updateChannelConfig).toHaveBeenCalledExactlyOnceWith("workspace_1", "channel_1", { deliveryAudienceBindings: bindings });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  confirmDialog.mockResolvedValue(true);
  vi.mocked(listChannelDestinations).mockResolvedValue([]);
  vi.mocked(listContextProjects).mockResolvedValue([]);
  vi.mocked(listWorkspaceMemberOptions).mockResolvedValue([]);
  vi.mocked(updateChannelConfig).mockResolvedValue(channel());
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });

describe("[COMP:app-web/channel-delivery-audiences] Delivery audience", () => {
  it("shows member-readable policies and approval metadata without edit/add/remove", async () => {
    await render(channel(), false);
    expect(host.textContent).toContain(copy.adminOnly);
    expect(host.textContent).toContain(first.channelId);
    expect(host.textContent).toContain(first.approvedByUserId);
    expect(host.textContent).toContain(first.approvedAt);
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("form")).toBeNull();
    expect(updateChannelConfig).not.toHaveBeenCalled();
  });
  it("adds a default group/public approval and preserves existing policy without server metadata", async () => {
    await render(); await add();
    expect(host.querySelectorAll('[role="combobox"][aria-labelledby]')[0].textContent).toContain(copy.group);
    expect(host.querySelectorAll('[role="combobox"][aria-labelledby]')[1].textContent).toContain(en.studioPage.channels.clearance.public);
    await click(copy.save);
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith({ title: copy.confirmTitle, description: copy.confirmDescription, confirmLabel: copy.confirmAction, cancelLabel: copy.cancel });
    expectWrite([input(first), input(second), { channelId: "-100333", audienceType: "group", clearance: "public", compartments: [], projectIds: [], recipientUserId: null, expiresAt: null }]);
    expect(onUpdated).toHaveBeenCalledWith(await vi.mocked(updateChannelConfig).mock.results[0].value);
    expect(host.querySelector("form")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(copy.saved);
  });
  it("edits only the chosen binding, normalizes lists and expiry, and selects sensitivity", async () => {
    await render(); await click(copy.edit);
    expect(field("channelId").value).toBe(first.channelId);
    expect(host.textContent).toContain("Finance");
    await pick(copy.chooseDepartment, "Ops");
    // Only departments the approver is in are offered.
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${copy.chooseDepartment}"]`)!.click());
    expect([...document.querySelectorAll('[role="option"]')].map((node) => node.textContent)).not.toContain("Board");
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${copy.chooseDepartment}"]`)!.click());
    await fill("projects", `${project}, ${project}`);
    await fill("expires", "2099-01-01T02:00:00+02:00");
    await select(1, en.studioPage.channels.clearance.confidential);
    await click(copy.save);
    expectWrite([{ ...input(first), clearance: "confidential", compartments: ["team:dept-finance", "team:dept-ops"] }, input(second)]);
  });
  it("removes only the targeted binding with removal-specific confirmation", async () => {
    await render(); await click(copy.remove, host.querySelectorAll("li")[1]);
    expect(confirmDialog).toHaveBeenCalledWith({ title: copy.removeTitle, description: copy.removeDescription, confirmLabel: copy.removeAction, cancelLabel: copy.cancel });
    expectWrite([input(first)]);
  });
  it.each(["save", "remove"])("cancelled %s confirmation never writes", async (operation) => {
    confirmDialog.mockResolvedValue(false); await render();
    if (operation === "save") { await add(); await click(copy.save); expect(field("channelId").value).toBe("-100333"); }
    else await click(copy.remove);
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(updateChannelConfig).not.toHaveBeenCalled(); expect(onUpdated).not.toHaveBeenCalled();
  });
  it.each([
    [401, "signInError"], [403, "permissionError"], [404, "missingIntegration"], [500, "saveError"],
  ] as const)("explains config HTTP %s errors without discarding the draft", async (status, key) => {
    vi.mocked(updateChannelConfig).mockRejectedValueOnce(new ChannelConfigUpdateError(status, "failure_code", []));
    await render(); await add(); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy[key]);
    expect(field("channelId").value).toBe("-100333"); expect(onUpdated).not.toHaveBeenCalled();
  });
  it("localizes invalid API field names and ignores unrecognized server identifiers", async () => {
    vi.mocked(updateChannelConfig).mockRejectedValueOnce(new ChannelConfigUpdateError(400, "Invalid config", ["projectIds", "private_unknown"]));
    await render(); await add(); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(`${copy.invalid} (${copy.projects})`);
    expect(host.textContent).not.toContain("private_unknown");
  });
  it("retains a failed save draft and allows a successful retry", async () => {
    vi.mocked(updateChannelConfig).mockRejectedValueOnce(new Error("offline"));
    await render(); await add(); await pick(copy.chooseDepartment, "Ops"); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.saveError);
    expect(field("channelId").value).toBe("-100333"); expect(host.querySelector(`button[aria-label="Remove Ops"]`)).not.toBeNull();
    expect(onUpdated).not.toHaveBeenCalled(); expect(button(copy.save).disabled).toBe(false);
    await click(copy.save);
    expect(updateChannelConfig).toHaveBeenCalledTimes(2);
    expect(vi.mocked(updateChannelConfig).mock.calls[1]).toEqual(vi.mocked(updateChannelConfig).mock.calls[0]);
    expect(onUpdated).toHaveBeenCalledOnce(); expect(host.querySelector("form")).toBeNull();
  });
  it.each([
    ["invalid project UUID", "projects", "not-a-uuid"],
    ["past expiry", "expires", "2000-01-01T00:00:00Z"],
    ["invalid expiry", "expires", "not-a-date"],
    ["timezone-free expiry", "expires", "2099-01-01T00:00:00"],
    ["duplicate destination", "channelId", first.channelId],
    ["Telegram positive group mismatch", "channelId", "12345"],
    ["Telegram nonnumeric ID", "channelId", "@group"],
    ["malformed Telegram topic", "channelId", "-100333:other:42"],
    ["topic shadowed by whole-chat approval", "channelId", "-100111:topic:42"],
  ])("rejects %s without confirmation or write", async (_name, key, value) => {
    await render(); await add(); await fill(key, value); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.invalid);
    expect(confirmDialog).not.toHaveBeenCalled(); expect(updateChannelConfig).not.toHaveBeenCalled();
  });
  it.each([
    ["slack", "D123456"],
    ["whatsapp", "+15555550123"],
    ["whatsapp", "15555550123@s.whatsapp.net"],
  ] as const)("rejects a group binding for %s individual %s", async (channelType, channelId) => {
    await render({ ...channel([]), channelType }); await add(); await fill("channelId", channelId); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.invalid);
    expect(updateChannelConfig).not.toHaveBeenCalled(); expect(confirmDialog).not.toHaveBeenCalled();
  });
  it("rejects a whole-chat approval that would overlap an existing topic", async () => {
    await render(channel([{ ...first, channelId: "-100111:topic:42" }]));
    await add(); await fill("channelId", "-100111"); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.invalid);
    expect(updateChannelConfig).not.toHaveBeenCalled();
  });
  it("keeps distinct topics independent when no whole-chat approval exists", async () => {
    const existing = { ...first, channelId: "-100111:topic:42" };
    await render(channel([existing])); await add(); await fill("channelId", "-100111:topic:43"); await click(copy.save);
    expectWrite([input(existing), { channelId: "-100111:topic:43", audienceType: "group", clearance: "public", compartments: [], projectIds: [], recipientUserId: null, expiresAt: null }]);
  });
  it("clears the personal recipient when switching an individual approval to group", async () => {
    await render(); await click(copy.edit, host.querySelectorAll("li")[1]);
    expect(field("recipient").value).toBe(recipient);
    await select(0, copy.group); await fill("channelId", "-100333"); await click(copy.save);
    expectWrite([input(first), { ...input(second), channelId: "-100333", audienceType: "group", recipientUserId: null }]);
  });
  it("rejects invalid recipient UUID and negative Telegram individual destinations", async () => {
    await render(); await add(); await select(0, copy.individual);
    await fill("channelId", "12345"); await fill("recipient", "not-a-uuid"); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.invalid);
    await fill("recipient", recipient); await fill("channelId", "-100333"); await click(copy.save);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.invalid);
    expect(confirmDialog).not.toHaveBeenCalled(); expect(updateChannelConfig).not.toHaveBeenCalled();
  });
  it("blocks a stale edit when refreshed props replace the binding list", async () => {
    await render(); await click(copy.edit); await fill("projects", "draft");
    await render(channel([second]));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.changed);
    expect(field("projects").disabled).toBe(true); expect(button(copy.save).disabled).toBe(true);
    await click(copy.save);
    expect(confirmDialog).not.toHaveBeenCalled(); expect(updateChannelConfig).not.toHaveBeenCalled();
    await click(copy.cancel); await click(copy.edit); expect(field("channelId").value).toBe(second.channelId);
  });
  it.each(["role revocation", "binding refresh"])("blocks pending confirmation after %s", async (change) => {
    const confirmation = deferred<boolean>(); confirmDialog.mockReturnValueOnce(confirmation.promise);
    await render(); await add(); await click(copy.save);
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(updateChannelConfig).not.toHaveBeenCalled();
    if (change === "role revocation") {
      await render(channel(), false);
      expect(host.querySelector("form")).toBeNull(); expect(host.querySelector("button")).toBeNull();
    } else await render(channel([second]));
    await act(async () => confirmation.resolve(true));
    expect(updateChannelConfig).not.toHaveBeenCalled(); expect(onUpdated).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.changed);
  });
  it("hides an open editor immediately when management permission is revoked", async () => {
    await render(); await add(); await render(channel(), false);
    expect(host.querySelector("form")).toBeNull(); expect(host.querySelector("button")).toBeNull();
    expect(confirmDialog).not.toHaveBeenCalled(); expect(updateChannelConfig).not.toHaveBeenCalled();
  });
});

async function pick(label: string, text: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.startsWith(text));
  expect(option).toBeDefined();
  await act(async () => option!.click());
}
it("loads only on open and scopes destinations to the exact integration, including seen topics", async () => {
  vi.mocked(listChannelDestinations).mockResolvedValue([
    { channelType: "telegram", channelId: "123", title: "My DM", channelIntegrationId: "integration_1", lastActiveAt: "" },
    { channelType: "telegram", channelId: "456", title: "Other bot", channelIntegrationId: "integration_2", lastActiveAt: "" },
    { channelType: "telegram", channelId: "789", title: "Unknown owner", lastActiveAt: "" },
  ]);
  const value = channel([]);
  value.config!.seenChats = [{ chatId: "-100555", chatTitle: "Broadcast", isForum: true, lastSeenAt: "", topics: [{ topicId: 42, name: "Planning", lastSeenAt: "" }] }];
  await render(value);
  expect(listChannelDestinations).not.toHaveBeenCalled();
  await click(copy.add);
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${copy.chooseDestination}"]`)!.click());
  expect(document.body.textContent).not.toContain("Other bot");
  expect(document.body.textContent).not.toContain("Unknown owner");
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.startsWith("Broadcast / Planning"));
  await act(async () => option!.click());
  expect(field("channelId").value).toBe("-100555:topic:42");
  await click(copy.save);
  expect(vi.mocked(updateChannelConfig).mock.calls[0][2].deliveryAudienceBindings?.[0]).toMatchObject({ channelId: "-100555:topic:42", audienceType: "group" });
});
it("adds project IDs without dropping unknown IDs and writes member ID rather than label", async () => {
  const known = "99999999-1234-1234-1234-123456789abc";
  vi.mocked(listContextProjects).mockResolvedValue([{ id: known, name: "Named project" } as Awaited<ReturnType<typeof listContextProjects>>[number]]);
  vi.mocked(listWorkspaceMemberOptions).mockResolvedValue([{ id: recipient, label: "Alice" }]);
  await render(); await click(copy.edit, host.querySelectorAll("li")[1]);
  await pick(copy.chooseProject, "Named project");
  expect(field("projects").value).toBe(`${project}, ${known}`);
  await pick(copy.chooseMember, "Alice");
  expect(field("recipient").value).toBe(recipient);
  await click(copy.save);
  expectWrite([input(first), { ...input(second), projectIds: [project, known] }]);
});
it("keeps manual inputs usable after option loading fails", async () => {
  vi.mocked(listContextProjects).mockRejectedValue(new Error("offline"));
  await render(); await add();
  expect(host.textContent).toContain(copy.optionsError);
  await fill("projects", project); await click(copy.save);
  expect(updateChannelConfig).toHaveBeenCalledOnce();
});
it("ignores option results after cancel and reopen", async () => {
  const pending = deferred<Awaited<ReturnType<typeof listWorkspaceMemberOptions>>>();
  vi.mocked(listWorkspaceMemberOptions).mockReturnValueOnce(pending.promise);
  await render(); await click(copy.add); await click(copy.cancel);
  await click(copy.edit, host.querySelectorAll("li")[1]);
  await act(async () => pending.resolve([{ id: recipient, label: "Obsolete member" }]));
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${copy.chooseMember}"]`)!.click());
  expect(document.body.textContent).not.toContain("Obsolete member");
});
it.each([
  ["telegram", "12345", "individual"],
  ["telegram", "-100777", "group"],
  ["slack", "D123", "individual"],
  ["slack", "C123", "group"],
  ["slack", "G123", "group"],
  ["whatsapp", "123456789@g.us", "group"],
  ["whatsapp", "123456789@s.whatsapp.net", "individual"],
] as const)("infers %s destination %s as %s", async (channelType, channelId, audienceType) => {
  const value = { ...channel([]), channelType };
  value.config!.seenChats = [{ chatId: channelId, chatTitle: "Known destination", isForum: false, topics: [], lastSeenAt: "" }];
  await render(value); await click(copy.add);
  await pick(copy.chooseDestination, "Known destination");
  await click(copy.save);
  expect(vi.mocked(updateChannelConfig).mock.calls[0][2].deliveryAudienceBindings?.[0]).toMatchObject({ channelId, audienceType });
});
it("preserves an existing unknown recipient and project on unchanged save", async () => {
  await render(); await click(copy.edit, host.querySelectorAll("li")[1]);
  expect(field("recipient").value).toBe(recipient);
  await click(copy.save);
  expectWrite([input(first), input(second)]);
});
it("blocks editing after integration identity changes with identical bindings", async () => {
  await render(); await click(copy.edit);
  await render({ ...channel(), integrationId: "another_bot" });
  expect(button(copy.save).disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(copy.changed);
  expect(updateChannelConfig).not.toHaveBeenCalled();
});
it("shows departments by name, removes one from an approval, and drops labels v2 no longer honours", async () => {
  const legacy: DeliveryAudienceBinding = { ...first, compartments: ["finance-legacy", "team:dept-finance"] };
  await render(channel([legacy]));
  expect(host.textContent).toContain("Finance");
  expect(host.textContent).not.toContain("finance-legacy");
  await click(copy.edit);
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="Remove Finance"]`)!.click());
  expect(host.textContent).toContain(copy.generalOnly);
  await click(copy.save);
  expectWrite([{ ...input(legacy), compartments: [] }]);
});
