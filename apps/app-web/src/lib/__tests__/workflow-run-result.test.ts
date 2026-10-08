import {describe,it,expect,vi} from 'vitest';
vi.mock('@/lib/runtime-public-config',()=>({publicRuntimeConfig:()=>({apiUrl:'https://api.example'})}));
vi.mock('@/lib/auth-fetch',()=>({authFetch:vi.fn()}));
vi.mock('@/lib/display-api-url',()=>({DISPLAY_API_URL:'https://api.example'}));
vi.mock('@use-brian/shared/builtin-connectors',()=>({OFFICIAL_CONNECTOR_TOOLS:[]}));
import {authFetch} from '@/lib/auth-fetch';
import {runWorkflowNow} from '../api/workflow';

describe('[COMP:app-web/workflow] manual result admission',()=>{
  it('preserves uncertain execution without returning protected fields or retrying',async()=>{
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({error:'run_result_unavailable',operationMayHaveExecuted:true,finalOutput:{private:'Unexpected payload'}}),{status:409}));
    expect(await runWorkflowNow('fictional-workflow')).toEqual({unavailable:true,operationMayHaveExecuted:true});
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});
