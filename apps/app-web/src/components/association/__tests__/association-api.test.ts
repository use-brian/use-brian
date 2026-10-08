import { beforeEach,describe,expect,it,vi } from "vitest";
const api=vi.hoisted(()=>({fetch:vi.fn(),contact:vi.fn(),sendability:vi.fn()}));
vi.mock("@/lib/auth-fetch",()=>({authFetch:api.fetch}));
vi.mock("@/lib/api/crm",()=>({fetchCrmRecord:api.contact,checkCrmSendability:api.sendability}));
import { associationModuleRemaining,getAssociationModuleSnapshot,listAssociationPage,exportAssociationAttendees,exportAssociationOperationalRoster,reserveAssociationOrder,offerAssociationPlace,retryAssociationProviderReceipt,saveAssociationEvent,saveAssociationPlan,saveAssociationPromotion,saveAssociationTicket,checkInAssociationAttendee,correctAssociationCheckIn } from "@/lib/api/association";
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const registration=(id:string,changes={})=>({id,attendeeContactId:`contact-${id}`,attendeeName:`Person ${id}`,attendeeEmail:`person-${id}@example.com`,status:"confirmed",...changes});
beforeEach(()=>{vi.resetAllMocks();api.sendability.mockResolvedValue({verdict:"allowed"});api.contact.mockImplementation(async(_ws,id)=>({record:{kind:"contact",archivedAt:null,email:`person-${id.replace("contact-","")}@example.com`}}));});
describe("[COMP:app-web/association] Native member wire contracts",()=>{
  it("bounds prefetched module authority from request start rather than response arrival",async()=>{
    const now=vi.spyOn(performance,"now").mockReturnValue(1000);
    try {
      api.fetch.mockImplementation(async(url)=>{
        now.mockReturnValue(11_000);
        return response(String(url).endsWith("/module")?{module:{workspaceId:"w",state:"enabled",version:1}}:{role:"admin"});
      });
      const snapshot=await getAssociationModuleSnapshot("w");
      expect(snapshot.canManage).toBe(true);expect(associationModuleRemaining(snapshot)).toBe(20_000);
      now.mockReturnValue(31_001);expect(associationModuleRemaining(snapshot)).toBe(0);
      expect(associationModuleRemaining({...snapshot})).toBe(0);
    } finally {now.mockRestore();}
  });
  it.each([
    ["plans","operations/entitlement-plans","plans"], ["events","operations/events","events"], ["memberships","operations/entitlements","entitlements"],
    ["promotions","association/promotions","promotions"],
    ["waitlist","association/waitlist","submissions"], ["receipts","association/provider-receipts","receipts"], ["audit","operations/audit","entries"], ["deliveries","operations/event-delivery","events"],
  ] as const)("reads %s using its canonical envelope and cursor",async(resource,path,key)=>{
    api.fetch.mockResolvedValue(response({[key]:[{id:"one"}],nextCursor:"next/value"}));
    expect(await listAssociationPage("workspace",resource,{cursor:"cursor+1"})).toEqual({items:[{id:"one"}],nextCursor:"next/value"});
    const url=new URL(api.fetch.mock.calls[0][0], "https://app.example");expect(url.pathname).toBe(`/api/crm/workspace/${path}`);expect(url.searchParams.get("cursor")).toBe("cursor+1");expect(url.searchParams.get("limit")).toBe("50");
  });
  it("does not treat missing page metadata, an invalid envelope or permission denial as an empty result",async()=>{
    for(const value of [{events:[]},{events:null,nextCursor:null},{events:[],nextCursor:42}]){
      api.fetch.mockResolvedValue(response(value));await expect(listAssociationPage("w","events")).rejects.toMatchObject({code:"invalid_response"});
    }
    api.fetch.mockResolvedValue(response({error:"not_authorized"},403));await expect(listAssociationPage("w","events")).rejects.toMatchObject({code:"not_authorized",status:403});
  });
  it("uses event-scoped paths and only allows the unpaged ticket contract to omit a cursor",async()=>{
    api.fetch.mockResolvedValue(response({tickets:[{id:"ticket"}]}));await listAssociationPage("w","tickets",{eventId:"event/id"});
    expect(api.fetch.mock.calls[0][0]).toContain("/association/events/event%2Fid/tickets?");
    expect(new URL(api.fetch.mock.calls[0][0], "https://app.example").searchParams.has("eventId")).toBe(false);
    api.fetch.mockResolvedValue(response({registrations:[],nextCursor:null}));await listAssociationPage("w","registrations",{eventId:"event",cursor:"next"});
    expect(api.fetch.mock.calls[1][0]).toContain("/events/event/registrations?limit=50&cursor=next");
  });
  it("sends canonical writes through member auth and preserves supplied replay identities",async()=>{
    api.fetch.mockImplementation(async()=>response({}));
    const order={contactId:"contact",idempotencyKey:"request-id",reservationMinutes:20,lines:[]};
    await reserveAssociationOrder("w",order);await reserveAssociationOrder("w",order);
    const promotion={promotionId:"promotion-id",reservationMinutes:20,useMemberPrice:false};await offerAssociationPlace("w","submission",promotion);
    await checkInAssociationAttendee("w","stable-registration");
    expect(api.fetch.mock.calls.slice(0,2).map(c=>JSON.parse(c[1].body))).toEqual([order,order]);
    expect(JSON.parse(api.fetch.mock.calls[2][1].body)).toEqual(promotion);
    expect(api.fetch.mock.calls[3]).toEqual([expect.stringContaining("/registrations/stable-registration"),expect.objectContaining({method:"PATCH",body:'{"status":"checked_in"}'})]);
    for(const [,options] of api.fetch.mock.calls) expect(options.headers).toEqual({"Content-Type":"application/json"});
  });
  it("retries one encoded provider receipt with an empty closed body",async()=>{
    api.fetch.mockResolvedValue(response({result:{id:"order"},receipt:{id:"receipt/id",state:"applied"}}));
    await retryAssociationProviderReceipt("workspace/id","receipt/id");
    const [url,options]=api.fetch.mock.calls[0];
    expect(url).toContain("/api/crm/workspace%2Fid/association/provider-receipts/receipt%2Fid/retry");
    expect(JSON.parse(options.body)).toEqual({});
  });
  it("submits a reason and expected state for one check-in correction",async()=>{
    api.fetch.mockResolvedValue(response({registration:{id:"registration/id",status:"confirmed"}}));
    await correctAssociationCheckIn("workspace/id","registration/id","checked_in","Scanned the wrong badge");
    const [url,options]=api.fetch.mock.calls[0];
    expect(new URL(url,"https://app.example").pathname).toBe("/api/crm/workspace%2Fid/association/registrations/registration%2Fid/check-in-correction");
    expect(JSON.parse(options.body)).toEqual({expectedStatus:"checked_in",reason:"Scanned the wrong badge"});
  });
  it("keeps generic plan/event configuration separate from vertical tickets",async()=>{
    api.fetch.mockImplementation(async()=>response({}));
    // The shape is independently checked by canonical server schemas; this checks routing.
    await saveAssociationPlan("w",{} as never);await saveAssociationEvent("w",{} as never);await saveAssociationTicket("w","event",{} as never);await saveAssociationPromotion("w",{} as never);
    expect(api.fetch.mock.calls.map(c=>new URL(c[0], "https://app.example").pathname)).toEqual(["/api/crm/w/operations/entitlement-plans","/api/crm/w/operations/events","/api/crm/w/association/events/event/tickets","/api/crm/w/association/promotions"]);
  });
});
describe("[COMP:app-web/association] Complete consent-filtered attendee download",()=>{
  it("traverses beyond 100 attendees and bounds parallel consent checks",async()=>{
    let inFlight=0,peak=0;
    api.sendability.mockImplementation(async()=>{peak=Math.max(peak,++inFlight);await Promise.resolve();--inFlight;return{verdict:"allowed"};});
    api.fetch.mockImplementation(async(raw)=>{const cursor=new URL(raw, "https://app.example").searchParams.get("cursor"),start=cursor?Number(cursor):0;return response({registrations:Array.from({length:start===100?3:50},(_,i)=>registration(String(start+i))),nextCursor:start<100?String(start+50):null});});
    const csv=await exportAssociationAttendees("w","event","updates");
    expect(csv.trim().split("\r\n")).toHaveLength(104);expect(csv).toContain('"102"');expect(api.sendability).toHaveBeenCalledTimes(103);expect(peak).toBeLessThanOrEqual(8);
    expect(api.sendability).toHaveBeenCalledWith("w","contact-102","email","updates");
  });
  it("excludes denied, unlinked, archived, mismatched addresses and unpaid reservations",async()=>{
    api.fetch.mockResolvedValue(response({registrations:[registration("yes"),registration("denied"),registration("archived"),registration("mismatch",{attendeeEmail:"old@example.com"}),registration("unlinked",{attendeeContactId:null}),registration("reserved",{status:"reserved"}),registration("cancelled",{status:"cancelled"})],nextCursor:null}));
    api.sendability.mockImplementation(async(_ws,id)=>({verdict:id==="contact-denied"?"blocked":"allowed"}));
    api.contact.mockImplementation(async(_ws,id)=>({record:{kind:"contact",archivedAt:id==="contact-archived"?"2026-01-01":null,email:`person-${id.replace("contact-","")}@example.com`}}));
    const csv=await exportAssociationAttendees("w","event","updates");expect(csv.trim().split("\r\n")).toHaveLength(2);expect(csv).toContain('"yes"');expect(api.sendability).not.toHaveBeenCalledWith("w","contact-reserved",expect.anything(),expect.anything());
  });
  it("aborts instead of returning a partial export after a later page or evaluator failure",async()=>{
    api.fetch.mockResolvedValueOnce(response({registrations:[registration("one")],nextCursor:"next"})).mockRejectedValueOnce(new Error("offline"));
    await expect(exportAssociationAttendees("w","event","updates")).rejects.toThrow("offline");
    api.fetch.mockResolvedValue(response({registrations:[registration("one")],nextCursor:null}));api.sendability.mockRejectedValue(new Error("evaluation unavailable"));
    await expect(exportAssociationAttendees("w","event","updates")).rejects.toThrow("evaluation unavailable");
  });
  it("rejects repeated cursors, deduplicates contact assessments and escapes spreadsheet cells",async()=>{
    const rows=[registration("one",{attendeeName:' =SUM(1,2) "quote"'}),registration("two",{attendeeContactId:"contact-one",attendeeEmail:"person-one@example.com"})];
    api.fetch.mockResolvedValueOnce(response({registrations:rows,nextCursor:null}));
    const csv=await exportAssociationAttendees("w","event","updates");expect(csv).toContain('"\' =SUM(1,2) ""quote"""');expect(api.sendability).toHaveBeenCalledTimes(1);
    api.fetch.mockImplementation(async()=>response({registrations:[],nextCursor:"loop"}));await expect(exportAssociationAttendees("w","event","updates")).rejects.toMatchObject({code:"invalid_cursor"});
  });
});
describe("[COMP:app-web/association] Complete operational roster download",()=>{
  const row=(id:string,changes={})=>({id,eventId:"event",orderId:`order-${id}`,orderLineId:`line-${id}`,ticketId:`ticket-${id}`,ticketKey:"standard",ticketName:"Standard",buyerContactId:`buyer-${id}`,attendeeContactId:`contact-${id}`,attendeeName:`Person ${id}`,attendeeEmail:`person-${id}@example.com`,phone:null,organisation:null,jobTitle:null,status:"reserved",checkedInAt:null,sourceKind:"commerce",sourceId:`line-${id}`,historicalImport:false,marketingConsent:false,ticketingConsent:true,policyVersion:null,policyAcceptedAt:null,questionResponses:null,createdAt:"2026-09-01T00:00:00Z",updatedAt:"2026-09-01T00:00:00Z",...changes});
  it("retains non-consented and terminal rows, follows every cursor and escapes cells",async()=>{
    api.fetch.mockResolvedValueOnce(response({registrations:[row("one",{attendeeName:" =SUM(1,2)",questionResponses:{diet:"none"}})],nextCursor:"next"}))
      .mockResolvedValueOnce(response({registrations:[row("two",{status:"refunded",marketingConsent:null})],nextCursor:null}));
    const csv=await exportAssociationOperationalRoster("w","event/id");
    expect(csv.trim().split("\r\n")).toHaveLength(3);expect(csv).toContain('"\' =SUM(1,2)"');expect(csv).toContain('"{""diet"":""none""}"');
    expect(csv).toContain('"refunded"');expect(csv).toContain('"false"');
    expect(api.fetch.mock.calls.map(call=>new URL(call[0],"https://app.example").pathname)).toEqual([
      "/api/crm/w/association/events/event%2Fid/operational-roster","/api/crm/w/association/events/event%2Fid/operational-roster"]);
  });
  it("fails closed on an invalid page or repeated cursor",async()=>{
    api.fetch.mockResolvedValueOnce(response({registrations:null,nextCursor:null}));
    await expect(exportAssociationOperationalRoster("w","event")).rejects.toMatchObject({code:"invalid_response"});
    api.fetch.mockImplementation(async()=>response({registrations:[],nextCursor:"loop"}));
    await expect(exportAssociationOperationalRoster("w","event")).rejects.toMatchObject({code:"invalid_cursor"});
  });
});
