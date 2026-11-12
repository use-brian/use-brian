// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const state=vi.hoisted(()=>({query:"",canManage:true as boolean|undefined}));
vi.mock("next/navigation",()=>({useSearchParams:()=>new URLSearchParams(state.query),useRouter:()=>({replace:vi.fn(),push:vi.fn()})}));
vi.mock("@/components/operator/operator-topbar",()=>({OperatorTopbar:()=>null}));
vi.mock("../module-controls",()=>({useAssociationModule:()=>state.canManage===undefined?{data:undefined,error:undefined}:{data:{module:{workspaceId:"w",state:"enabled",version:1},canManage:state.canManage},error:undefined}}));
vi.mock("../overview",()=>({AssociationOverview:()=> <div data-overview/>}));
vi.mock("../membership-publishing",()=>({MembershipPublishingPanel:({initialPlan}:{initialPlan:string})=> <div data-membership-editor={initialPlan}/>}));
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
describe("[COMP:app-web/association] Staff navigation",()=>{
  it("shows only the primary staff tasks and keeps system links out even for owners",async()=>{
    await render();
    expect(host.querySelector("[data-overview]")).not.toBeNull();
    expect(links()).toEqual(["overview", "events", "plans", "memberships", "contacts"].map(section => href(section as Parameters<typeof href>[0])));
    state.query="section=admin&tab=sync";await render();
    expect(host.querySelector("[data-overview]")).not.toBeNull();
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(u.home);
  });
  it("preserves the access gate for an older link to website editing",async()=>{
    state.query="section=website";
    state.canManage=undefined;await render();
    expect(host.querySelector("[data-website]")).toBeNull();
    expect(host.querySelector("[data-admin-only]")).toBeNull();
    state.canManage=false;await render();
    expect(host.querySelector("[data-website]")).toBeNull();
    expect(host.querySelector("[data-admin-only]")).not.toBeNull();
  });
  it("keeps old section links working through aliases",()=>{
    const resolve=(query:string)=>resolveAssociationSection(new URLSearchParams(query));
    expect(resolve("section=memberships&view=plans")).toBe("plans");
    expect(resolve("section=memberships&view=payments")).toBe("payments");
    expect(resolve("section=operations")).toBe("overview");
    expect(resolve("section=settings")).toBe("overview");
    expect(resolve("section=settings&tab=keys")).toBe("overview");
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
    state.query="section=website&page=membership&plan=sample-plan";await render();
    expect(host.querySelector("[data-membership-editor]")?.getAttribute("data-membership-editor")).toBe("sample-plan");
    state.query="section=contacts";await render();expect(host.querySelector("[data-contacts]")).not.toBeNull();
  });
  it("recovers an unknown section to Home",async()=>{
    state.query="section=unknown";await render();expect(host.querySelector("[data-overview]")).not.toBeNull();
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe(u.home);
  });
});
