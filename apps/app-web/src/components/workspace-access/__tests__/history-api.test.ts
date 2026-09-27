// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fetchWorkspaceAccessHistory} from '@/lib/api/workspace-access';
import {SurfaceCacheEvictionError} from '@/lib/surface-cache';
const mocks=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.fetch}));
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.example'})}));
beforeEach(()=>mocks.fetch.mockReset());
describe('[COMP:app-web/workspace-access] history transport and protected lifetime',()=>{
  it.each(['requests','grants'] as const)('binds %s history to its cursor and policy revision without cache reuse',async kind=>{
    mocks.fetch.mockResolvedValue({ok:true,json:async()=>({kind,requests:[],grants:[],nextCursor:null,validForMs:30000})});
    const value=await fetchWorkspaceAccessHistory('workspace',kind,'anchor','14');
    expect(mocks.fetch).toHaveBeenCalledWith(`https://api.example/api/workspaces/workspace/access/${kind}?after=anchor&expectedPolicyRevision=14`,{cache:'no-store'});
    expect(value.projectionDeadline).toBeLessThanOrEqual(Date.now()+30000);
    expect(value.projectionMonotonicDeadline).toBeGreaterThan(performance.now());
  });
  it('evicts a stale page on policy conflict rather than retaining its old metadata',async()=>{
    mocks.fetch.mockResolvedValue({ok:false,status:409,json:async()=>({error:'access_history_changed'})});
    await expect(fetchWorkspaceAccessHistory('workspace','requests','anchor','1')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
  });
  it('rejects an already expired projection',async()=>{
    mocks.fetch.mockResolvedValue({ok:true,json:async()=>({validForMs:0,requests:[],grants:[]})});
    await expect(fetchWorkspaceAccessHistory('workspace','grants','anchor','1')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
  });
});
