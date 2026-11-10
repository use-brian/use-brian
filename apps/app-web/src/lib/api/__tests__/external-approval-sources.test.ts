import { beforeEach, describe, expect, it, vi } from 'vitest';
const {authFetch} = vi.hoisted(() => ({authFetch:vi.fn()}));
vi.mock('@/lib/auth-fetch', () => ({authFetch}));
vi.mock('@/lib/runtime-public-config', () => ({publicRuntimeConfig:() => ({apiUrl:'https://api.example.test'})}));
import {createExternalApprovalSource, listExternalApprovalSources, listExternalApprovalDestinations, rotateExternalApprovalSource, revokeExternalApprovalSource} from '../external-approval-sources';
import {resetSurfaceCache, readSurfaceCache} from '@/lib/surface-cache';
import {externalApprovalSourcesCacheKey} from '@/lib/surface-prefetch';
const source = {id:'source',workspaceId:'ws',name:'App',assistantId:'assistant',approverUserId:'human',channelType:'web',channelId:'human',prefix:'prefix',createdAt:'2026-01-01',revokedAt:null};
beforeEach(() => {vi.clearAllMocks(); resetSurfaceCache();});
describe('[COMP:app-web/external-approvals] API client', () => {
  it('scopes and encodes URLs, sends only strict registration fields, never caches issuance', async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({source,token:'synthetic-one-time'}),{status:201}));
    const input = {name:'App',assistantId:'assistant',destinationId:'session:integration',channelId:'forbidden-extra',approverUserId:'forbidden-person',notification:'web'};
    expect((await createExternalApprovalSource('ws/other',input)).token).toBe('synthetic-one-time');
    const [url,init] = authFetch.mock.calls[0];
    expect(url).toBe('https://api.example.test/api/workspaces/ws%2Fother/external-approval-sources');
    expect(JSON.parse(init.body)).toEqual({name:'App',assistantId:'assistant',destinationId:'session:integration'});
    expect(init.cache).toBe('no-store');
    expect(readSurfaceCache(externalApprovalSourcesCacheKey('ws/other','viewer')).data).toBeUndefined();
  });
  it('projects only public metadata even if a server accidentally returns additional fields', async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({sources:[{...source,token:'not-metadata',tokenHash:'not-metadata'}]})));
    expect(await listExternalApprovalSources('ws')).toEqual([source]);
    expect(authFetch.mock.calls[0][1].cache).toBe('no-store');
  });
  it('rotates with an empty body and revokes the scoped source', async () => {
    authFetch.mockResolvedValueOnce(new Response(JSON.stringify({source,token:'synthetic-rotated'}))).mockResolvedValueOnce(new Response(null,{status:204}));
    await rotateExternalApprovalSource('ws','id/slash'); await revokeExternalApprovalSource('ws','id/slash');
    expect(authFetch.mock.calls[0][0]).toContain('/ws/external-approval-sources/id%2Fslash/rotate');
    expect(authFetch.mock.calls[0][1]).toMatchObject({method:'POST',body:'{}',cache:'no-store'});
    expect(authFetch.mock.calls[1][1]).toMatchObject({method:'DELETE',cache:'no-store'});
  });
  it('never exposes server error text', async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({error:'unsafe server detail'}),{status:403}));
    await expect(createExternalApprovalSource('ws',{name:'App',assistantId:'a',destinationId:'session'})).rejects.toThrow('external_approval_source_failed');
  });
});

describe('[COMP:app-web/external-approvals] destinations', () => {
  it('encodes workspace and assistant, projects public fields only and preserves opaque IDs', async () => {
    const destination = {id:'session:integration',sessionId:'session',assistantId:'a/b',channelType:'web',channelId:'chat',label:'Web chat'};
    const connection = {id:'integration',channelType:'chat',label:'Connected channel',available:false,reason:'no_conversation'};
    authFetch.mockResolvedValue(new Response(JSON.stringify({destinations:[{...destination,token:'unsafe'}],connections:[{...connection,tokenHash:'unsafe'}]})));
    expect(await listExternalApprovalDestinations('ws/other','a/b')).toEqual({destinations:[destination],connections:[connection]});
    expect(authFetch.mock.calls[0]).toEqual(['https://api.example.test/api/workspaces/ws%2Fother/external-approval-sources/destinations?assistantId=a%2Fb',{cache:'no-store'}]);
  });
  it.each([401,403,404])('evicts inaccessible destination metadata on %s without exposing response', async status => {
    authFetch.mockResolvedValue(new Response('unsafe details',{status}));
    await expect(listExternalApprovalDestinations('ws','a')).rejects.toMatchObject({name:'SurfaceCacheEvictionError',cause:{status}});
  });
});
