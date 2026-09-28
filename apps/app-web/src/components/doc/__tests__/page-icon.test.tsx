// @vitest-environment jsdom
/** Page icons consume authenticated file bytes, with identity-scoped
 * expiry and current-authority invalidation.
 * [COMP:app-web/page-icon]
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FileText } from "lucide-react";

const { mockAuthFetch } = vi.hoisted(() => ({ mockAuthFetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mockAuthFetch }));

import { WorkspaceContextProvider } from "@/lib/workspace-context";
import { resetSurfaceCache,readSurfaceCache } from "@/lib/surface-cache";
import { applySpineEventToSurfaceCache } from "@/lib/surface-cache-invalidation";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { docMediaCacheKey } from "@/lib/surface-prefetch";
vi.mock("@/lib/api/workspaces",()=>({updateWorkspacePickerPreferences:vi.fn(async()=>{})}));

import { PageIcon } from "../page-icon";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "11111111-2222-3333-4444-555555555555";
// Distinct file ids per test — the object-URL cache is module-level.
const token = (tail: string) =>
  `img:${WS}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeee${tail}`;

const bytesResponse = () => ({
  ok: true,
  headers: new Headers({ "content-type": "image/png", "X-Brian-Media-Valid-For-Ms":"30000" }),
  blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
});

describe("[COMP:app-web/page-icon] PageIcon", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const mockFetch = vi.fn();

  beforeEach(() => {
    resetSurfaceCache();
    mockAuthFetch.mockReset();
    vi.stubGlobal("URL",class extends URL {static createObjectURL=vi.fn(()=>`blob:${Math.random()}`);static revokeObjectURL=vi.fn();});
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    if (!URL.createObjectURL) {
      // jsdom lacks createObjectURL; a deterministic stub is fine — we only
      // assert the <img> wiring, not blob semantics.
      URL.createObjectURL = (() => "blob:stub") as typeof URL.createObjectURL;
    }
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    resetSurfaceCache();vi.useRealTimers();vi.unstubAllGlobals();
  });

  const view=(node:React.ReactNode,userId="viewer")=><WorkspaceContextProvider value={{workspaceId:WS,name:"Fixture",role:"member",clearance:"internal",me:{id:userId}}}>{node}</WorkspaceContextProvider>;

  async function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(view(node)));
    await act(async () => {});
  }

  it("renders an emoji value as the historical span", async () => {
    await mount(
      <PageIcon icon="🌱" fallback={FileText} emojiClassName="text-[15px]" />,
    );
    expect(container!.querySelector("span")?.textContent).toBe("🌱");
    expect(container!.querySelector("img")).toBeNull();
    expect(mockAuthFetch).not.toHaveBeenCalled();
  });

  it("renders the derived glyph when there is no icon", async () => {
    await mount(
      <PageIcon icon={null} fallback={FileText} glyphClassName="size-4" />,
    );
    expect(container!.querySelector("svg")).not.toBeNull();
    expect(container!.querySelector("img")).toBeNull();
  });

  it("loads authenticated bytes and renders an img token, cached across mounts", async () => {
    mockAuthFetch.mockResolvedValue(bytesResponse());
    const t = token("0001");

    await mount(
      <PageIcon icon={t} fallback={FileText} imgClassName="size-4" />,
    );
    const img = container!.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/^blob:/);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
    expect(String(mockAuthFetch.mock.calls[0][0])).toContain(
      `/api/doc-files/${WS}/`,
    );
    expect(String(mockAuthFetch.mock.calls[0][0])).toContain("redirect=0");
    expect(mockAuthFetch.mock.calls[0][1]).toEqual({cache:'no-store'});
    expect(mockFetch).not.toHaveBeenCalled();

    // Second mount of the same token: served from the module cache, no fetch.
    act(() => root!.unmount());
    container!.remove();
    await mount(
      <PageIcon icon={t} fallback={FileText} imgClassName="size-4" />,
    );
    expect(container!.querySelector("img")).not.toBeNull();
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);
  });

  it("renders directly returned image bytes", async () => {
    mockAuthFetch.mockResolvedValue(bytesResponse());

    await mount(
      <PageIcon icon={token("0003")} fallback={FileText} imgClassName="size-4" />,
    );
    expect(container!.querySelector("img")).not.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to the glyph when the icon fetch fails", async () => {
    mockAuthFetch.mockResolvedValue({ ok: false, status: 404 });
    await mount(
      <PageIcon
        icon={token("0002")}
        fallback={FileText}
        glyphClassName="size-4"
      />,
    );
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.querySelector("svg")).not.toBeNull();
  });

  it("falls back to the glyph when the authorized response body fails", async () => {
    mockAuthFetch.mockResolvedValue({ok:true,blob:async()=>{throw new Error('incomplete body')}});
    await mount(
      <PageIcon
        icon={token("0004")}
        fallback={FileText}
        glyphClassName="size-4"
      />,
    );
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.querySelector("svg")).not.toBeNull();
  });
  it('shares a single current read across simultaneous icons',async()=>{
    mockAuthFetch.mockResolvedValue(bytesResponse());const t=token('0005');
    await mount(<><PageIcon icon={t} fallback={FileText}/><PageIcon icon={t} fallback={FileText}/></>);
    expect(mockAuthFetch).toHaveBeenCalledTimes(1);expect(container!.querySelectorAll('img')).toHaveLength(2);
    const sources=[...container!.querySelectorAll('img')].map(img=>img.src);expect(sources[0]).toBe(sources[1]);
  });

  it('purges displayed content on authority loss and rejects a late detached response',async()=>{
    mockAuthFetch.mockResolvedValueOnce(bytesResponse());const t=token('0006');
    await mount(<PageIcon icon={t} fallback={FileText}/>);
    const old=container!.querySelector('img')!.src;
    let finish!:(value:unknown)=>void;
    mockAuthFetch.mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
    await act(async()=>applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:WS},WS));
    expect(container!.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith(old);
    mockAuthFetch.mockResolvedValue({ok:false,status:404});
    await act(async()=>applySpineEventToSurfaceCache(WORKSPACE_IDENTITY_REFRESH_EVENT,{workspaceId:WS},WS));
    await act(async()=>finish(bytesResponse()));
    expect(container!.querySelector('img')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('never paints a previous viewer or source while the next read is pending',async()=>{
    mockAuthFetch.mockResolvedValueOnce(bytesResponse());const t=token('0007');
    await mount(<PageIcon icon={t} fallback={FileText}/>);
    const old=container!.querySelector('img')!.src;
    mockAuthFetch.mockImplementation(()=>new Promise(()=>{}));
    await act(async()=>root!.render(view(<PageIcon icon={t} fallback={FileText}/>,'next-viewer')));
    expect(container!.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith(old);
    expect(readSurfaceCache(docMediaCacheKey(WS,'viewer',t.split('/')[1])).data).toBeUndefined();
  });

  it.each(['focus','visibilitychange'])('purges before a fresh read on %s',async event=>{
    mockAuthFetch.mockResolvedValueOnce(bytesResponse());await mount(<PageIcon icon={token('0008')} fallback={FileText}/>);
    const old=container!.querySelector('img')!.src;mockAuthFetch.mockImplementation(()=>new Promise(()=>{}));
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
    await act(async()=>{(event==='focus'?window:document).dispatchEvent(new Event(event));});
    expect(container!.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith(old);
  });

  it('removes expired mounted content and disposes cached unmounted content',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
    const response=bytesResponse();response.headers.set('X-Brian-Media-Valid-For-Ms','500');
    mockAuthFetch.mockResolvedValueOnce(response);await mount(<PageIcon icon={token('0009')} fallback={FileText}/>);
    expect(container!.querySelector('img')).not.toBeNull();
    mockAuthFetch.mockImplementation(()=>new Promise(()=>{}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(501);});
    expect(container!.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('purges a mounted icon on logout reset',async()=>{
    mockAuthFetch.mockResolvedValueOnce(bytesResponse());await mount(<PageIcon icon={token('0010')} fallback={FileText}/>);
    mockAuthFetch.mockImplementation(()=>new Promise(()=>{}));
    await act(async()=>resetSurfaceCache());
    expect(container!.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

});
