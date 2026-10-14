// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const api=vi.hoisted(()=>({listEngineeringHistory:vi.fn(),readEngineeringHistory:vi.fn(),correctEngineeringHistory:vi.fn(),exportEngineeringHistory:vi.fn()}));
vi.mock("@/lib/api/engineering-history",()=>api);
vi.mock("@/components/ui/confirm-dialog",()=>({confirmDialog:vi.fn(async()=>true)}));
import {HistoryReader} from "../history-reader";
import {I18nProvider} from "@/lib/i18n/client";
import {en} from "@/lib/i18n/dictionaries/en";
import {ja} from "@/lib/i18n/dictionaries/ja";
import {zh} from "@/lib/i18n/dictionaries/zh";
import {zhCN} from "@/lib/i18n/dictionaries/zh-cn";
import {resetSurfaceCache,readSurfaceCache,loadSurfaceCache,SurfaceCacheEvictionError} from "@/lib/surface-cache";
import {applySpineEventToSurfaceCache} from "@/lib/surface-cache-invalidation";
import {engineeringHistoryCacheKey} from "@/lib/surface-prefetch";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const event={id:"event-fictional",fileId:"file-fictional",fileVersion:"1",revision:1,sequence:"1",provider:"codex",role:"user",occurredAt:"2026-01-01T00:00:00Z",receivedAt:"2026-01-01T00:00:01Z",excerpt:"A selected prompt",content:"  original\n工程 ☃\n\t",sessionId:"session-fictional",principalKind:"api_key",principalId:"key-fictional",actorId:"actor-fictional",claimedSubject:null,profileId:"profile-fictional",sourceEventId:"source-fictional",annotations:[]};
let root:Root,host:HTMLDivElement;
async function settle(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})}
async function button(label:string){const b=Array.from(host.querySelectorAll("button")).find(x=>x.textContent===label);expect(b).toBeTruthy();await act(async()=>{b!.click()});await settle()}
beforeEach(()=>{resetSurfaceCache();vi.clearAllMocks();host=document.createElement("div");document.body.append(host);root=createRoot(host);api.listEngineeringHistory.mockResolvedValue({events:[event],nextCursor:null,serverHealth:{index:"available",localEmitterObserved:false}});api.readEngineeringHistory.mockResolvedValue(event);api.correctEngineeringHistory.mockResolvedValue({status:"annotated"})});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache()});
describe("[COMP:app-web/engineering-history] localized admitted reader",()=>{
 it.each([["en",en],["ja",ja],["zh",zh],["zh-CN",zhCN]] as const)("EH14 renders %s with separate health and protected original detail",async(locale,dict)=>{
  await act(async()=>root.render(<I18nProvider locale={locale} dict={dict}><HistoryReader workspaceId="fixture-workspace"/></I18nProvider>));await settle();
  expect(host.textContent).toContain(dict.engineeringHistory.title);expect(host.textContent).toContain(dict.engineeringHistory.localHealth);expect(host.textContent).toContain(dict.engineeringHistory.serverHealth);
  await act(async()=>{host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click()});await settle();
  expect(host.querySelector("pre")?.textContent).toBe(event.content);expect(host.textContent).toContain(dict.engineeringHistory.unverified);expect(host.querySelector("select")).toBeNull();expect(host.querySelectorAll('input[type="text"]').length).toBeGreaterThan(0)
 });
 it("EH14 source/access change purges list and detail and an authoritative denial removes cached original",async()=>{
  const key=engineeringHistoryCacheKey("fixture-workspace","event:event-fictional");await loadSurfaceCache(key,async()=>event);expect(readSurfaceCache(key).data).toBeTruthy();
  applySpineEventToSurfaceCache("brian:organization-changed",{workspaceId:"fixture-workspace"},"fixture-workspace");expect(readSurfaceCache(key).data).toBeUndefined();
  await loadSurfaceCache(key,async()=>event);await loadSurfaceCache(key,async()=>{throw new SurfaceCacheEvictionError(new Error("history_not_available"))});expect(readSurfaceCache(key).data).toBeUndefined()
 });
 it("EH09 sends lexical filters through the shared HTTP adapter and does not expose configuration controls",async()=>{
  await act(async()=>root.render(<I18nProvider locale="en" dict={en}><HistoryReader workspaceId="fixture-workspace"/></I18nProvider>));await settle();
  const input=host.querySelector<HTMLInputElement>("form input")!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"selected");input.dispatchEvent(new Event("input",{bubbles:true}))});
  await act(async()=>{host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))});await settle();expect(api.listEngineeringHistory).toHaveBeenLastCalledWith("fixture-workspace",{query:"selected",limit:50});expect(host.textContent).not.toContain(en.engineeringHistory.create)
 });
});
