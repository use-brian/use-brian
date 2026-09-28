// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const state=vi.hoisted(()=>({query:"",canManage:true as boolean|undefined}));
vi.mock("next/navigation",()=>({useSearchParams:()=>new URLSearchParams(state.query),useRouter:()=>({replace:vi.fn(),push:vi.fn()})}));
vi.mock("@/components/operator/operator-topbar",()=>({OperatorTopbar:()=>null}));
vi.mock("../module-controls",()=>({useAssociationModule:()=>state.canManage===undefined?{data:undefined,error:undefined}:{data:{module:{workspaceId:"w",state:"enabled",version:1},canManage:state.canManage},error:undefined}}));
vi.mock("../overview",()=>({AssociationOverview:()=> <div data-overview/>}));
vi.mock("../admin-panel",()=>({AssociationAdminPanel:({tab}:{tab?:string})=> <div data-admin={tab ?? ""}/>}));
vi.mock("../website-content",()=>({AssociationWebsiteSection:()=> <div data-website/>}));
vi.mock("../sponsorships",()=>({AssociationSponsorshipsSection:()=> <div data-sponsorships/>}));
vi.mock("../contacts/contacts-section",()=>({AssociationContactsSection:()=> <div data-contacts/>}));
vi.mock("../members-panel",()=>({AssociationMembersPanel:({initialNew}:{initialNew:boolean})=> <div data-members={String(initialNew)}/>}));
vi.mock("../plans-panel",()=>({AssociationPlansPanel:()=> <div data-plans/>}));
vi.mock("../payments-panel",()=>({AssociationPaymentsPanel:()=> <div data-payments/>}));
vi.mock("../events-panel",()=>({AssociationEventsPanel:({initialEventId}:{initialEventId:string})=><div data-events={initialEventId}/>}));
vi.mock("../promotions-panel",()=>({AssociationPromotionsPanel:()=>null}));
vi.mock("../orders-panel",()=>({AssociationOrdersPanel:({initialEventId}:{initialEventId:string})=><div data-event-filter={initialEventId}/>}));
vi.mock("../waitlist-panel",()=>({AssociationWaitlistPanel:()=>null}));
import { AssociationSurface, resolveAssociationSection, associationHref } from "../association-surface";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const u=en.associationPage.ux;
let host:HTMLDivElement,root:Root;
beforeEach(()=>{state.query="";state.canManage=true;host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(){await act(async()=>root.render(<I18nProvider locale="en" dict={en}><AssociationSurface workspaceId="fictional-workspace"/></I18nProvider>));}
const links=()=>[...host.querySelectorAll("nav a")].map(link=>link.getAttribute("href"));
const href=(section:Parameters<typeof associationHref>[1])=>associationHref("fictional-workspace",section);
describe("[COMP:app-web/association] Grouped dashboard navigation",()=>{
  it("groups the console like a website dashboard and opens Home by default",async()=>{
    await render();expect(host.querySelector("[data-overview]")).not.toBeNull();
    const text=host.querySelector("nav")!.textContent!;
    for(const label of [u.navWebsite,u.navEvents,u.navSales,u.navMembership,u.navContacts,u.navAdmin])expect(text).toContain(label);
    for(const section of ["website","events","orders","plans","contacts","admin"] as const)expect(links()).toContain(href(section));
    state.query="section=admin&tab=sync";await render();expect(host.querySelector("[data-admin]")?.getAttribute("data-admin")).toBe("sync");
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(u.admin);
  });
  it("hides owner/admin sections from members and explains a direct link instead of showing an empty page",async()=>{
    state.canManage=false;await render();
    for(const section of ["website","promotions","payments","sponsorships","admin"] as const)expect(links()).not.toContain(href(section));
    expect(links()).toContain(href("contacts"));
    state.query="section=admin&tab=keys";await render();
    expect(host.querySelector("[data-admin]")).toBeNull();expect(host.querySelector("[data-admin-only]")?.textContent).toContain(u.adminOnlyTitle);
    state.query="section=website";await render();expect(host.querySelector("[data-website]")).toBeNull();expect(host.querySelector("[data-admin-only]")).not.toBeNull();
  });
  it("renders nothing role-dependent until the role is known",async()=>{
    state.canManage=undefined;await render();expect(links()).not.toContain(href("admin"));
    state.query="section=admin";await render();expect(host.querySelector("[data-admin]")).toBeNull();expect(host.querySelector("[data-admin-only]")).toBeNull();
  });
  it("keeps old section links working through aliases",()=>{
    const resolve=(query:string)=>resolveAssociationSection(new URLSearchParams(query));
    expect(resolve("section=memberships&view=plans")).toBe("plans");
    expect(resolve("section=memberships&view=payments")).toBe("payments");
    expect(resolve("section=operations")).toBe("admin");
    expect(resolve("section=settings")).toBe("admin");
    expect(resolve("section=settings&tab=keys")).toBe("admin");
    expect(resolve("section=settings&tab=website")).toBe("website");
    expect(resolve("section=settings&tab=sponsorship")).toBe("sponsorships");
    expect(resolve("section=memberships")).toBe("memberships");
    expect(resolve("section=unknown")).toBe("overview");
    expect(resolveAssociationSection(null)).toBe("overview");
  });
  it("opens tasks directly and preserves event-filtered links",async()=>{
    state.query="section=memberships&view=plans";await render();expect(host.querySelector("[data-plans]")).not.toBeNull();
    state.query="section=memberships&new=1";await render();expect(host.querySelector("[data-members]")?.getAttribute("data-members")).toBe("true");
    state.query="section=orders&eventId=fictional-event";await render();expect(host.querySelector("[data-event-filter]")?.getAttribute("data-event-filter")).toBe("fictional-event");
    state.query="section=events&eventId=fictional-event";await render();expect(host.querySelector("[data-events]")?.getAttribute("data-events")).toBe("fictional-event");
    state.query="section=settings&tab=website";await render();expect(host.querySelector("[data-website]")).not.toBeNull();
    state.query="section=contacts";await render();expect(host.querySelector("[data-contacts]")).not.toBeNull();
  });
  it("recovers an unknown section to Home",async()=>{
    state.query="section=unknown";await render();expect(host.querySelector("[data-overview]")).not.toBeNull();
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(u.home);
  });
});
