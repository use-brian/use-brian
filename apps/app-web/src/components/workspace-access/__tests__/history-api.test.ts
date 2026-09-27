// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fetchWorkspaceAccessHistory,fetchWorkspaceDepartmentRegistry} from '@/lib/api/workspace-access';
import {SurfaceCacheEvictionError} from '@/lib/surface-cache';
const mocks=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.fetch}));
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.example'})}));
beforeEach(()=>mocks.fetch.mockReset());
describe('[COMP:app-web/workspace-access] history transport and protected lifetime',()=>{
  it('uses the no-store registry endpoint and rejects expired authority',async()=>{
    mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>({validForMs:30000,teams:[]})});
    const result=await fetchWorkspaceDepartmentRegistry('workspace');expect(result.teams).toEqual([]);
    expect(mocks.fetch).toHaveBeenCalledWith('https://api.example/api/workspaces/workspace/access/registry',{cache:'no-store'});
    mocks.fetch.mockResolvedValueOnce({ok:false,status:403,json:async()=>({error:'not_found'})});
    await expect(fetchWorkspaceDepartmentRegistry('workspace')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
  });
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
