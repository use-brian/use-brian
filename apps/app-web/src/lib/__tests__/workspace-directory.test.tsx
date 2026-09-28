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
import {fetchPages,isCurrentDirectoryPage,isCurrentDirectoryPerson,listWorkspaceMembers,readWorkspaceMemberDirectory,readWorkspacePageDirectory} from '@/lib/api/mentions'
import {loadWorkspaceRoster} from '@/lib/api/workspace-roster'
import {useWorkspaceDirectory} from '@/lib/use-workspace-directory'
import {pageDirectoryCacheKey,workspaceMemberDirectoryCacheKey} from '@/lib/surface-prefetch'

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true

const members=[
  {memberId:'member-a',userId:'person-a',name:'Ari Example',email:'ari@example.com',avatarUrl:null,role:'member' as const,canDraft:true},
  {memberId:'member-b',userId:'person-b',name:'Bo Example',email:'bo@example.com',avatarUrl:null,role:'admin' as const,canDraft:false},
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

  it('derives task member ids from the same bounded member projection',async()=>{
    await render()
    await expect(loadWorkspaceRoster('workspace-a')).resolves.toEqual([
      {id:'member-a',userId:'person-a',email:'ari@example.com',userName:'Ari Example',avatarUrl:null,role:'member',canDraft:true},
      {id:'member-b',userId:'person-b',email:'bo@example.com',userName:'Bo Example',avatarUrl:null,role:'admin',canDraft:false},
    ])
    expect(state.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:app-web/mention-fetchers] bounded page directory',()=>{
  const pageResponse=(viewerId=state.viewer,validForMs=6_000)=>new Response(JSON.stringify({
    workspaceId:'workspace-a',viewerId,validForMs,pages:[
      {id:'page-a',title:'Current plan'},
      {id:'page-b',title:'Roadmap'},
    ],
  }),{status:200})

  it('shares one current projection, filters locally and binds selection to it',async()=>{
    state.fetch.mockResolvedValue(pageResponse())
    const rows=await fetchPages('workspace-a','road')
    expect(rows.map(row=>row.id)).toEqual(['page-b'])
    expect(isCurrentDirectoryPage('workspace-a',rows[0]!)).toBe(true)
    expect(state.fetch).toHaveBeenCalledTimes(1)
    expect(state.fetch.mock.calls[0]).toEqual([expect.stringContaining('/api/workspaces/workspace-a/page-directory'),{cache:'no-store'}])
    expect((await fetchPages('workspace-a','current')).map(row=>row.id)).toEqual(['page-a'])
    expect(state.fetch).toHaveBeenCalledTimes(1)
    invalidateSurfaceCache(pageDirectoryCacheKey('workspace-a','viewer-a'))
    expect(isCurrentDirectoryPage('workspace-a',rows[0]!)).toBe(false)
  })

  it('rejects cross-viewer page publications and expires cached titles',async()=>{
    state.fetch.mockResolvedValue(pageResponse('viewer-b'))
    await expect(readWorkspacePageDirectory('workspace-a','viewer-a')).rejects.toBeInstanceOf(SurfaceCacheEvictionError)
    vi.useFakeTimers()
    state.fetch.mockResolvedValue(pageResponse('viewer-a',800))
    const rows=await fetchPages('workspace-a','')
    expect(rows).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(801)
    expect(isCurrentDirectoryPage('workspace-a',rows[0]!)).toBe(false)
  })
})
