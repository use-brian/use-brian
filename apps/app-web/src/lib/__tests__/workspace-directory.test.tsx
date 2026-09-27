// @vitest-environment jsdom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'

const state=vi.hoisted(()=>({viewer:'viewer-a',fetch:vi.fn(),listeners:new Set<()=>void>()}))
vi.mock('@/lib/user',()=>({
  getUserInfo:()=>state.viewer?{id:state.viewer}:null,
  subscribeUserInfo:(listener:()=>void)=>{state.listeners.add(listener);return()=>state.listeners.delete(listener)},
}))
vi.mock('@/lib/auth-fetch',()=>({authFetch:(...args:unknown[])=>state.fetch(...args)}))

import {invalidateSurfaceCache,resetSurfaceCache,SurfaceCacheEvictionError} from '@/lib/surface-cache'
import {isCurrentDirectoryPerson,listWorkspaceMembers,readWorkspaceMemberDirectory} from '@/lib/api/mentions'
import {useWorkspaceDirectory} from '@/lib/use-workspace-directory'
import {workspaceMemberDirectoryCacheKey} from '@/lib/surface-prefetch'

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true

const members=[
  {userId:'person-a',name:'Ari Example',email:'ari@example.com',avatarUrl:null},
  {userId:'person-b',name:'Bo Example',email:'bo@example.com',avatarUrl:null},
]
const response=(viewerId=state.viewer,validForMs=6_000)=>new Response(JSON.stringify({workspaceId:'workspace-a',viewerId,validForMs,members}),{status:200})
const pending=()=>new Promise<Response>(()=>{})

function Probe({query}:{query?:string}) {
  const rows=useWorkspaceDirectory('workspace-a',query)
  return <div>{rows.map(row=><span key={row.id} data-person={row.id}>{row.name}</span>)}</div>
}

let host:HTMLDivElement,root:Root
async function render(query?:string){await act(async()=>{root.render(<Probe query={query}/>);await Promise.resolve();await Promise.resolve()})}

beforeEach(()=>{
  resetSurfaceCache();vi.clearAllMocks();state.listeners.clear();state.viewer='viewer-a';state.fetch.mockResolvedValue(response())
  host=document.createElement('div');document.body.append(host);root=createRoot(host)
})
afterEach(()=>{act(()=>root.unmount());host.remove();resetSurfaceCache();vi.useRealTimers()})

describe('[COMP:app-web/mention-fetchers] bounded workspace directory',()=>{
  it('shares one viewer/workspace read and filters names locally',async()=>{
    await render('ari')
    expect(host.textContent).toContain('Ari Example')
    expect(host.textContent).not.toContain('Bo Example')
    expect(state.fetch).toHaveBeenCalledTimes(1)
    expect(state.fetch.mock.calls[0]).toEqual([expect.stringContaining('/api/workspaces/workspace-a/member-directory'),{cache:'no-store'}])
    await render('bo')
    expect(host.textContent).toContain('Bo Example')
    expect(state.fetch).toHaveBeenCalledTimes(1)
  })

  it('expires visible people and does not retain them through a failed renewal',async()=>{
    vi.useFakeTimers();state.fetch.mockResolvedValueOnce(response('viewer-a',800)).mockImplementation(pending)
    await render();expect(host.textContent).toContain('Ari Example')
    await act(async()=>vi.advanceTimersByTime(801))
    expect(host.textContent).not.toContain('Ari Example')
  })

  it('drops the old projection synchronously when the viewer changes',async()=>{
    await render();expect(host.textContent).toContain('Ari Example')
    state.fetch.mockImplementation(pending);state.viewer='viewer-b'
    await act(async()=>{for(const listener of state.listeners)listener();await Promise.resolve()})
    expect(host.textContent).not.toContain('Ari Example')
    expect(state.fetch).toHaveBeenCalledTimes(2)
  })

  it('requires a person to come from the current cached projection',async()=>{
    await render()
    const [person]=await listWorkspaceMembers('workspace-a')
    expect(person).toBeDefined()
    expect(isCurrentDirectoryPerson('workspace-a',person!)).toBe(true)
    await act(async()=>invalidateSurfaceCache(workspaceMemberDirectoryCacheKey('workspace-a','viewer-a')))
    expect(isCurrentDirectoryPerson('workspace-a',person!)).toBe(false)
  })

  it('rejects a response bound to another viewer',async()=>{
    state.fetch.mockResolvedValue(response('viewer-b'))
    await expect(readWorkspaceMemberDirectory('workspace-a','viewer-a')).rejects.toBeInstanceOf(SurfaceCacheEvictionError)
  })
})
