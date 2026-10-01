// @vitest-environment jsdom
import {describe,it,expect,vi,beforeEach} from 'vitest';
import {fetchWorkspaceCreationContext} from '@/lib/api/workspace-access';
import {SurfaceCacheEvictionError,loadSurfaceCache,readSurfaceCache,resetSurfaceCache} from '@/lib/surface-cache';
import {applySpineEventToSurfaceCache,SURFACE_CACHE_SPINE_EVENTS} from '@/lib/surface-cache-invalidation';
const fetch=vi.hoisted(()=>vi.fn());
vi.mock('@/lib/api/studio',()=>({listAssistants:async()=>[]}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:fetch}));
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.test'})}));
beforeEach(()=>{fetch.mockReset();resetSurfaceCache();});
describe('[COMP:app-web/mode-aware-context] transport and unmounted authority',()=>{
 it('loads only authorized team/project choices without caching HTTP responses and binds the revision',async()=>{
 fetch.mockImplementation(async(url:string)=>({ok:true,json:async()=>url.endsWith('/mode')?{policyRevision:'4',validForMs:30000}:url.endsWith('/groups')?{groups:[{id:'t'},{id:'read-only'}]}:url.includes('/access/explain')?{policyRevision:'4',validForMs:30000,mutationTeamIds:['t'],projectIds:[]}:{projects:[]}}));
 const data=await fetchWorkspaceCreationContext('w');expect(data.policyRevision).toBe('4');expect(data.teams).toEqual([{id:'t'}]);for(const call of fetch.mock.calls)expect(call[1].cache).toBe('no-store');
 });
 it('evicts choices when authority is denied rather than retaining old metadata',async()=>{
 fetch.mockResolvedValue({ok:false,status:403,json:async()=>({error:'not_found'})});await expect(fetchWorkspaceCreationContext('w')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
 });
 it('purges unmounted viewer-scoped mode and creation keys on organization changes',async()=>{
 for(const key of ['workspace-access:w:u:mode','workspace-access:w:other:creation-context'])await loadSurfaceCache(key,async()=>({secret:true}));
 expect(SURFACE_CACHE_SPINE_EVENTS).toContain('brian:organization-changed');applySpineEventToSurfaceCache('brian:organization-changed',{workspaceId:'w'},'w');
 expect(readSurfaceCache('workspace-access:w:u:mode')?.data).toBeUndefined();expect(readSurfaceCache('workspace-access:w:other:creation-context')?.data).toBeUndefined();
 });
});
