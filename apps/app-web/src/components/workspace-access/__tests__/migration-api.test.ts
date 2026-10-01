// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fetchMigrationPlans,fetchMigrationPlan,prepareMigrationItem,applyMigrationItem,setMigrationPlanState} from '@/lib/api/workspace-access';
import {SurfaceCacheEvictionError} from '@/lib/surface-cache';
const mocks=vi.hoisted(()=>({fetch:vi.fn(),invalidate:vi.fn()}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:mocks.fetch}));
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.example'})}));
vi.mock('@/lib/surface-cache',async original=>({...await original<typeof import('@/lib/surface-cache')>(),invalidateSurfaceCache:mocks.invalidate}));
beforeEach(()=>{vi.clearAllMocks();mocks.fetch.mockResolvedValue({ok:true,json:async()=>({plans:[]})});});
describe('[COMP:app-web/workspace-access] migration transport',()=>{
  it('uses actual list envelope and cursor with a bounded no-store projection',async()=>{
    const result=await fetchMigrationPlans('w','cursor');
    expect(result.plans).toEqual([]);expect(result.projectionDeadline).toBeLessThanOrEqual(Date.now()+30000);
    expect(mocks.fetch).toHaveBeenCalledWith('https://api.example/api/workspaces/w/access/migrations?after=cursor',{cache:'no-store'});
  });
  it.each([401,403,404])('evicts protected plans on %s',async status=>{
    mocks.fetch.mockResolvedValue({ok:false,status,json:async()=>({error:'not_found'})});
    await expect(fetchMigrationPlan('w','p')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
  });
  it('prepares one item and posts only the exact saved confirmation on apply',async()=>{
    await prepareMigrationItem('w','p','i');
    expect(mocks.fetch.mock.calls[0][0]).toContain('/p/items/i/review');expect(mocks.fetch.mock.calls[0][1].body).toBe('{}');
    const confirmation={type:'access.command.apply' as const,reviewId:'r',payloadHash:'exact-saved-hash'};
    await applyMigrationItem('w','p','i',confirmation);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual(confirmation);
    expect(mocks.invalidate).toHaveBeenCalledWith('workspace-access:w:');
  });
  it('invalidates unmounted viewers after an uncertain apply and preserves the server error',async()=>{
    mocks.fetch.mockRejectedValue(new Error('connection_lost'));
    await expect(applyMigrationItem('w','p','i',{type:'access.command.apply',reviewId:'r',payloadHash:'h'})).rejects.toThrow('connection_lost');
    expect(mocks.invalidate).toHaveBeenCalledWith('workspace-access:w:');
  });
  it('keeps resource confirmation and nullable canonical expiry distinct and applies exactly the returned fields',async()=>{
    const confirmation={kind:'resource' as const,reviewId:'resource-review',expectedVersion:'17',payloadHash:'h'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z'};
    const prepared={kind:'resource',item:{id:'i'},review:{id:'resource-review',expiresAt:null},confirmation};
    mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>prepared});
    const result=await prepareMigrationItem('w','p','i');expect(result).toEqual(prepared);
    expect(mocks.invalidate).toHaveBeenCalledWith('scope-review:w:');
    await applyMigrationItem('w','p','i',confirmation);
    expect(mocks.fetch.mock.calls[1][0]).toContain('/p/items/i/apply');expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual(confirmation);
    expect(mocks.invalidate).toHaveBeenCalledWith('workspace-access:w:');
  });
  it.each(['stale','cancelled','applied'])('preserves resource receipt status %s without treating HTTP 200 as completion',async status=>{
    const receipt={id:'i',kind:'resource',status,review:{status:status==='applied'?'complete':status}};
    mocks.fetch.mockResolvedValueOnce({ok:true,json:async()=>receipt});
    expect(await applyMigrationItem('w','p','i',{kind:'resource',reviewId:'r',expectedVersion:'1',payloadHash:'h',expiresAt:'2099-01-01T00:00:00.000Z'})).toEqual(receipt);
  });
  it('retains resource supersession errors and purges even unmounted source review caches',async()=>{
    mocks.fetch.mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:'access_review_changed'})});
    await expect(applyMigrationItem('w','p','i',{kind:'resource',reviewId:'old',expectedVersion:'1',payloadHash:'h',expiresAt:'2099-01-01T00:00:00.000Z'})).rejects.toThrow('access_review_changed');
    expect(mocks.invalidate).toHaveBeenCalledWith('scope-review:w:');
  });
  it('sends resume as proposed, not a fabricated resume endpoint',async()=>{
    await setMigrationPlanState('w','p','proposed');
    expect(mocks.fetch.mock.calls[0][0]).toContain('/p/state');expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({state:'proposed'});
  });
});
