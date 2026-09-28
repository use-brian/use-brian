// @vitest-environment jsdom
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
const {mockAuthFetch}=vi.hoisted(()=>({mockAuthFetch:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mockAuthFetch}));
import {fetchDocMediaProjection,fetchDocFileBlob,fetchCachedMediaProjection,fetchOfficeMediaProjection} from '../doc-file-url';
describe('[COMP:app-web/doc-file-url] authenticated media bytes',()=>{
  const directFetch=vi.fn(),create=vi.fn(()=> 'blob:fixture');
  beforeEach(()=>{mockAuthFetch.mockReset();directFetch.mockReset();create.mockClear();vi.stubGlobal('fetch',directFetch);vi.stubGlobal('URL',class extends URL {static createObjectURL=create;});});
  afterEach(()=>vi.unstubAllGlobals());
  it.each(['image/png','application/json','text/plain'])('preserves %s content with no provider fetch',async mime=>{
    const blob=new Blob(['{"url":"https://storage.example/must-not-fetch"}'],{type:mime});
    mockAuthFetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':'30000'}),blob:async()=>blob});
    expect(await fetchDocFileBlob('ws_1','wf_1')).toBe(blob);
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining('/api/doc-files/ws_1/wf_1?redirect=0'),{cache:'no-store'});
    expect(directFetch).not.toHaveBeenCalled();
  });
  it('creates a local object URL after the authorized read',async()=>{
    const blob=new Blob(['fixture']);mockAuthFetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':'30000'}),blob:async()=>blob});
    expect((await fetchDocMediaProjection('ws_1','wf_1')).url).toBe('blob:fixture');expect(create).toHaveBeenCalledWith(blob);expect(directFetch).not.toHaveBeenCalled();
  });
  it.each([401,403,404])('withholds media on HTTP %s',async status=>{
    mockAuthFetch.mockResolvedValue({ok:false,status});
    await expect(fetchDocFileBlob('ws_1','wf_1')).rejects.toMatchObject({cause:expect.objectContaining({message:`doc file fetch failed: HTTP ${status}`})});
    expect(create).not.toHaveBeenCalled();expect(directFetch).not.toHaveBeenCalled();
  });
  it.each(['original','pdf'] as const)('reads cached %s bytes through authenticated no-store admission',async representation=>{
    mockAuthFetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':'30000'}),blob:async()=>new Blob(['fixture'],{type:'application/pdf'})});
    const result=await fetchCachedMediaProjection('workspace','file',representation);
    expect(result.url).toBe('blob:fixture');expect(result.mimeType).toBe('application/pdf');
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining('/api/files/file/'+(representation==='pdf'?'preview-pdf':'preview')+'?workspaceId=workspace'),{cache:'no-store'});
    expect(directFetch).not.toHaveBeenCalled();
  });
  it.each([null,'','0','-1','NaN','Infinity'])('refuses an absent or invalid display lifetime (%s)',async lifetime=>{
    const headers=new Headers();if(lifetime!==null)headers.set('X-Brian-Media-Valid-For-Ms',lifetime);
    mockAuthFetch.mockResolvedValue({ok:true,headers,blob:async()=>new Blob(['protected'])});
    await expect(fetchDocMediaProjection('ws_1','wf_1')).rejects.toThrow();expect(create).not.toHaveBeenCalled();
  });
  it('subtracts body transfer time and rejects bytes arriving after expiry',async()=>{
    const now=vi.spyOn(performance,'now').mockReturnValueOnce(100).mockReturnValue(201);
    mockAuthFetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':'100'}),blob:async()=>new Blob(['protected'])});
    await expect(fetchDocMediaProjection('ws_1','wf_1')).rejects.toThrow();expect(create).not.toHaveBeenCalled();now.mockRestore();
  });
  it('caps a display lifetime and preserves a conservatively shortened deadline',async()=>{
    const now=vi.spyOn(performance,'now').mockReturnValueOnce(100).mockReturnValue(160);
    mockAuthFetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':'60000'}),blob:async()=>new Blob(['protected'])});
    const projection=await fetchDocMediaProjection('ws_1','wf_1');
    expect(projection.projectionMonotonicDeadline).toBe(30100);expect(projection.url).toBe('blob:fixture');expect(projection.mimeType).toBe('');now.mockRestore();
  });

  it('uses artifact-scoped no-store Office admission with the initiating workspace',async()=>{
    mockAuthFetch.mockResolvedValue({ok:true,headers:new Headers({'X-Brian-Media-Valid-For-Ms':'30000'}),blob:async()=>new Blob(['fixture'],{type:'image/png'})});
    expect((await fetchOfficeMediaProjection('workspace','artifact','resource')).url).toBe('blob:fixture');
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining('/api/office/artifacts/artifact/resources/resource?workspaceId=workspace'),{cache:'no-store'});
  });

});
