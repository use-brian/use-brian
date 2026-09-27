// @vitest-environment jsdom
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
const {mockAuthFetch}=vi.hoisted(()=>({mockAuthFetch:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mockAuthFetch}));
import {fetchDocFileBlob,resolveDocFileSrc,resolveFileRefUrl,type FileRef} from '../doc-file-url';
const durableRef:FileRef={bucket:'workspace_files',path:'wf_1',mimeType:'image/png',sizeBytes:3,name:'fixture.png'};
describe('[COMP:app-web/doc-file-url] authenticated media bytes',()=>{
  const directFetch=vi.fn(),create=vi.fn(()=> 'blob:fixture');
  beforeEach(()=>{mockAuthFetch.mockReset();directFetch.mockReset();create.mockClear();vi.stubGlobal('fetch',directFetch);vi.stubGlobal('URL',class extends URL {static createObjectURL=create;});});
  afterEach(()=>vi.unstubAllGlobals());
  it.each(['image/png','application/json','text/plain'])('preserves %s content with no provider fetch',async mime=>{
    const blob=new Blob(['{"url":"https://storage.example/must-not-fetch"}'],{type:mime});
    mockAuthFetch.mockResolvedValue({ok:true,blob:async()=>blob});
    expect(await fetchDocFileBlob('ws_1','wf_1')).toBe(blob);
    expect(mockAuthFetch).toHaveBeenCalledWith(expect.stringContaining('/api/doc-files/ws_1/wf_1?redirect=0'),{cache:'no-store'});
    expect(directFetch).not.toHaveBeenCalled();
  });
  it('creates a local object URL after the authorized read',async()=>{
    const blob=new Blob(['fixture']);mockAuthFetch.mockResolvedValue({ok:true,blob:async()=>blob});
    expect(await resolveDocFileSrc('ws_1','wf_1')).toBe('blob:fixture');expect(create).toHaveBeenCalledWith(blob);expect(directFetch).not.toHaveBeenCalled();
  });
  it.each([401,403,404])('withholds media on HTTP %s',async status=>{
    mockAuthFetch.mockResolvedValue({ok:false,status});
    await expect(fetchDocFileBlob('ws_1','wf_1')).rejects.toThrow(`HTTP ${status}`);
    expect(await resolveFileRefUrl(durableRef,'ws_1')).toBeNull();expect(create).not.toHaveBeenCalled();expect(directFetch).not.toHaveBeenCalled();
  });
  it('routes durable references through the same byte reader',async()=>{
    mockAuthFetch.mockResolvedValue({ok:true,blob:async()=>new Blob(['fixture'])});
    expect(await resolveFileRefUrl(durableRef,'ws_1')).toBe('blob:fixture');
  });
});
