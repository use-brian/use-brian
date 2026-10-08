// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ get: vi.fn(), change: vi.fn(), confirm: vi.fn(), orders: vi.fn(), order: vi.fn(), orderChange: vi.fn(), list: vi.fn(), lookup: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/api/association", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/api/association")>(), getAssociationModuleSnapshot: api.get, changeAssociationModule: api.change,
  listAssociationPage: api.list, listAssociationOrders: api.orders, getAssociationOrder: api.order, changeAssociationOrder: api.orderChange,
}));
vi.mock("@/lib/surface-prefetch", () => ({ associationPageCacheKey: (w: string, r: string, q = {}) => `crm:${w}:viewer:${r}:${JSON.stringify(q)}`, associationModuleCacheKey: (workspaceId: string) => `association-module:${workspaceId}:viewer`,
  associationOrdersCacheKey: (workspaceId: string, cursor: string | null) => `association-orders:${workspaceId}:viewer:${cursor ?? "first"}` }));
vi.mock("@/lib/api/crm", () => ({ fetchCrmRecord: api.record, fetchCrmLookup: api.lookup }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: api.confirm }));
import { AssociationApiError, type AssociationOrder } from "@/lib/api/association";
import { AssociationModuleControls, AssociationModuleNote } from "../module-controls";
import { AssociationOrdersPanel } from "../orders-panel";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const t = en.associationPage;
let host: HTMLDivElement, root: Root;
const moduleRow = (state = "disabled", version = 1) => ({ workspaceId: "w1", state, version });
async function render(note = false) {
  const view = note ? <AssociationModuleNote workspaceId="w1" /> : <AssociationModuleControls workspaceId="w1" />;
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>{view}</I18nProvider>));
}
async function click(label: string) {
  await act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === label)!.click(); });
}
beforeEach(() => {
  resetSurfaceCache(); vi.resetAllMocks();
  api.list.mockResolvedValue({items:[],nextCursor:null});api.lookup.mockResolvedValue([]);
  api.get.mockResolvedValue({ module: moduleRow(), canManage: true });
  api.confirm.mockResolvedValue(true);
  api.change.mockResolvedValue({ module: moduleRow("enabled", 2), changed: true, pendingOrders: 0 });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetSurfaceCache(); vi.useRealTimers(); });

describe("[COMP:app-web/association] Independent module controls", () => {
  it("confirms the observed version and never changes Home or assistant grants", async () => {
    await render(); api.get.mockResolvedValue({ module: moduleRow("enabled",2), canManage:true }); await click(t.enable);
    expect(api.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: t.enableConfirm }));
    expect(api.change).toHaveBeenCalledExactlyOnceWith("w1", "enable", 1);
    expect(host.textContent).toContain(t.states.enabled);
    expect(host.textContent).toContain(t.moduleDescription);
    expect(host.querySelector('a[href="/w/w1/association?section=orders"]')).not.toBeNull();
  });
  it("keeps members and assistant permission notes read-only without hiding history", async () => {
    api.get.mockResolvedValue({ module: moduleRow(), canManage: false });
    await render();
    expect(host.textContent).toContain(t.ownerOnly);
    expect([...host.querySelectorAll("button")].some(button => button.textContent === t.enable)).toBe(false);
    await act(async () => { resetSurfaceCache(); });
    api.get.mockResolvedValue({ module: moduleRow(), canManage: true });
    await render(true);
    expect(host.textContent).toContain(`${t.moduleStateLabel}: ${t.states.disabled}. ${t.savedPermissions}`);
    expect(host.textContent).not.toContain(t.moduleTitle);
    expect(host.querySelectorAll("button, a").length).toBe(0);
    expect(api.change).not.toHaveBeenCalled();
  });
  it("keeps a cancelled confirmation side-effect free", async () => {
    api.confirm.mockResolvedValue(false);
    await render(); await click(t.enable);
    expect(api.change).not.toHaveBeenCalled();
    expect(host.textContent).toContain(t.states.disabled);
  });
  it("refreshes a stale conflict before using the next observed version", async () => {
    await render();
    api.get.mockResolvedValue({ module: moduleRow("draining", 3), canManage: true });
    api.change.mockRejectedValueOnce(new AssociationApiError("stale_module_version", 409));
    await click(t.enable);
    expect(host.textContent).toContain(t.stale);
    expect(host.textContent).toContain(t.states.draining);
    api.change.mockRejectedValueOnce(new AssociationApiError("module_drain_pending", 409));
    await click(t.finish);
    expect(api.change).toHaveBeenLastCalledWith("w1", "finish_disable", 3);
    expect(host.textContent).toContain(t.pendingOrders);
  });
  it("keeps last-good state during failed refresh and disables changes", async () => {
    await render(); api.get.mockRejectedValue(new Error("offline"));
    await click(t.refresh);
    expect(host.textContent).toContain(t.states.disabled);
    expect(host.textContent).toContain(t.loadFailed);
    const enable = [...host.querySelectorAll("button")].find(button => button.textContent === t.enable)!;
    expect(enable.disabled).toBe(true);
    expect(api.change).not.toHaveBeenCalled();
  });
  it.each([401,403,404])("evicts module controls immediately on a %s renewal",async(status)=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await render();api.get.mockRejectedValue(new AssociationApiError("unavailable",status));
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect(host.textContent).not.toContain(t.states.disabled);
    expect([...host.querySelectorAll("button")].some(button=>button.textContent===t.enable)).toBe(false);
    expect(host.textContent).toContain(t.loadFailed);
    api.get.mockResolvedValue({module:moduleRow(),canManage:false});await click(t.refresh);
    expect(host.textContent).toContain(t.ownerOnly);expect(api.change).not.toHaveBeenCalled();
  });
  it("expires a module snapshot even while its renewal is stuck",async()=>{
    vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
    await render();let finish!:(value:unknown)=>void;api.get.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_001);});
    expect(host.textContent).not.toContain(t.states.disabled);
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_001);finish({module:moduleRow(),canManage:true});});
    expect([...host.querySelectorAll("button")].some(button=>button.textContent===t.enable)).toBe(false);
  });
  it("does not carry an old management grant into a successful module response",async()=>{
    await render();api.get.mockResolvedValue({module:moduleRow("enabled",2),canManage:false});await click(t.enable);
    expect(host.textContent).toContain(t.states.enabled);expect(host.textContent).toContain(t.ownerOnly);
    expect([...host.querySelectorAll("button")].some(button=>button.textContent===t.disable)).toBe(false);
  });
  it("revalidates the shared module cache on a workspace-config stale mark", async () => {
    await render(); api.get.mockResolvedValue({ module: moduleRow("draining", 5), canManage: true });
    await act(async () => markSurfaceCacheStale("association-module:w1"));
    expect(host.textContent).toContain(t.states.draining);
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});

const orderRow = (id = "order-one", status: AssociationOrder["status"] = "pending", totalMinor = "0"): AssociationOrder => ({
  id, status, currency: "USD", subtotalMinor: totalMinor, discountMinor: "0", totalMinor, contactId: "contact-one", reservationExpiresAt: null,
  provider: null, providerReference: null, promotionId: null, promotionSnapshot: null, createdAt: "2026-09-13T00:00:00.000Z",
  refundedMinor: "0", refundState: "none", disputeState: "none",
});
async function renderOrders() {
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><AssociationOrdersPanel workspaceId="w1" /></I18nProvider>));
}
describe("[COMP:app-web/association] Order history and recovery", () => {
  it("follows the server continuation and returns to the cached preceding page", async () => {
    api.orders.mockImplementation(async (_workspaceId, cursor) => cursor
      ? { orders: [orderRow("order-next")], nextCursor: null }
      : { orders: Array.from({ length: 50 }, (_, i) => orderRow(`order-${i}`)), nextCursor: "next-cursor" });
    await renderOrders();
    expect(host.querySelectorAll("[data-order-row]")).toHaveLength(50);
    await click(t.next);
    expect(api.orders).toHaveBeenLastCalledWith("w1", "next-cursor", {});
    expect(host.querySelectorAll("[data-order-row]")).toHaveLength(1);
    await click(t.previous);
    expect(host.querySelectorAll("[data-order-row]")).toHaveLength(50);
  });
  it("uses the same order identity for reviewed cancellation and refreshes canonical state", async () => {
    api.orders.mockResolvedValue({ orders: [orderRow()], nextCursor: null });
    await renderOrders();
    api.orders.mockResolvedValue({ orders: [orderRow("order-one", "cancelled")], nextCursor: null });
    api.orderChange.mockResolvedValue({ order: orderRow("order-one", "cancelled") });
    await click(t.cancelOrder);
    expect(api.orderChange).toHaveBeenCalledExactlyOnceWith("w1", "order-one", "cancel");
    expect(host.textContent).toContain(t.orderStates.cancelled);
    expect(host.textContent).not.toContain(t.confirmFree);
  });
  it("never exposes free confirmation for a priced or settled order", async () => {
    api.orders.mockResolvedValue({ orders: [orderRow("priced", "pending", "100"), orderRow("paid", "paid")], nextCursor: null });
    await renderOrders();
    expect([...host.querySelectorAll("button")].filter(button => button.textContent === t.confirmFree)).toHaveLength(0);
    expect([...host.querySelectorAll("button")].filter(button => button.textContent === t.cancelOrder)).toHaveLength(1);
  });
  it("shows normalized partial refund and dispute evidence without offering a financial mutation", async () => {
    api.orders.mockResolvedValue({ orders: [{ ...orderRow("financial", "paid", "1000"), refundedMinor: "400",
      refundState: "partial", disputeState: "open" }], nextCursor: null });
    await renderOrders();
    expect(host.querySelector("[data-order-refund]")?.textContent).toContain(t.refundStates.partial);
    expect(host.querySelector("[data-order-refund]")?.textContent).toContain("$4.00");
    expect(host.querySelector("[data-order-dispute]")?.textContent).toContain(t.disputeStates.open);
    expect(api.orderChange).not.toHaveBeenCalled();
  });
  it("shows filtered server totals and loads exact lines and attendees only on request", async () => {
    const order={...orderRow("financial", "paid", "1000"),refundedMinor:"400",refundState:"partial"};
    api.orders.mockResolvedValue({orders:[order],nextCursor:null,financialSummary:[{currency:"USD",orderCount:1,settledOrderCount:1,
      subtotalMinor:"1200",discountMinor:"200",grossMinor:"1000",refundedMinor:"400",netMinor:"600",pendingMinor:"0"}]});
    api.order.mockResolvedValue({...order,lines:[{id:"line-one",ticketId:"ticket-one",ticketKey:"standard",ticketName:"Standard",
      quantity:1,unitPriceMinor:"1000",discountMinor:"200",lineTotalMinor:"1000",pricingBasis:"member",eligibleMembershipId:"membership-one"}],
      registrations:[{id:"registration-one",eventId:"event-one",ticketId:"ticket-one",orderId:"financial",attendeeContactId:"contact-one",
        attendeeName:"Fictional Attendee",attendeeEmail:"attendee@example.test",status:"confirmed",sourceKind:"commerce",checkedInAt:null}]});
    await renderOrders();
    expect(host.querySelector("[data-order-financial-summary]")?.textContent).toContain("$6.00");
    expect(api.order).not.toHaveBeenCalled();
    await click(t.orderDetails);
    expect(api.order).toHaveBeenCalledExactlyOnceWith("w1","financial");
    expect(host.querySelector("[data-order-details]")?.textContent).toContain("Standard");
    expect(host.querySelector("[data-order-details]")?.textContent).toContain("Fictional Attendee");
  });
  it("does not auto-retry an uncertain mutation or send a cancelled confirmation", async () => {
    api.orders.mockResolvedValue({ orders: [orderRow()], nextCursor: null });
    await renderOrders(); api.confirm.mockResolvedValueOnce(false);
    await click(t.confirmFree); expect(api.orderChange).not.toHaveBeenCalled();
    api.orderChange.mockRejectedValueOnce(new Error("response lost"));
    await click(t.confirmFree);
    expect(api.orderChange).toHaveBeenCalledExactlyOnceWith("w1", "order-one", "confirm-free");
    expect(host.textContent).toContain(t.orderSaveFailed);
  });
});


describe("[COMP:app-web/association] Protected order projections",()=>{
  const page=()=>({orders:[orderRow()],nextCursor:null,financialSummary:[{currency:"USD",orderCount:1,settledOrderCount:1,subtotalMinor:"1000",discountMinor:"0",grossMinor:"1000",refundedMinor:"0",netMinor:"1000",pendingMinor:"0"}]});
  const detail=()=>({...orderRow(),lines:[],registrations:[{id:"guest-one",attendeeName:"Protected fictional attendee",status:"confirmed"}]});
  const fakeClock=()=>vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setInterval","clearInterval","performance"]});
  it("evicts attendee details on denial while the parent remains visible and supports retry",async()=>{
    fakeClock();api.orders.mockImplementation(async()=>page());api.order.mockImplementation(async()=>detail());
    await renderOrders();await click(t.orderDetails);expect(host.textContent).toContain("Protected fictional attendee");
    api.order.mockRejectedValue(new AssociationApiError("forbidden",403));
    await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
    expect(host.textContent).not.toContain("Protected fictional attendee");expect(host.textContent).toContain(t.orderDetailsFailed);
    api.order.mockImplementation(async()=>detail());
    await act(async()=>{host.querySelector<HTMLButtonElement>("[data-order-details] button")!.click();});
    expect(host.textContent).toContain("Protected fictional attendee");
  });
  it("removes rows, totals and expanded details when offline renewals outlive their authority",async()=>{
    fakeClock();api.orders.mockImplementation(async()=>page());api.order.mockImplementation(async()=>detail());
    await renderOrders();await click(t.orderDetails);
    api.orders.mockRejectedValue(new Error("offline"));api.order.mockRejectedValue(new Error("offline"));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_001);});
    expect(host.querySelector("[data-order-row]")).toBeNull();expect(host.querySelector("[data-order-financial-summary]")).toBeNull();
    expect(host.textContent).not.toContain("Protected fictional attendee");expect(host.textContent).toContain(t.ordersLoadFailed);
  });
  it("does not show a late detail response after its parent is removed",async()=>{
    api.orders.mockImplementation(async()=>page());let finish!:(value:unknown)=>void;
    api.order.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    await renderOrders();await click(t.orderDetails);
    api.orders.mockResolvedValue({orders:[],nextCursor:null});await click(t.refresh);
    await act(async()=>finish(detail()));
    expect(host.textContent).not.toContain("Protected fictional attendee");expect(host.querySelector("[data-order-details]")).toBeNull();
  });
});
