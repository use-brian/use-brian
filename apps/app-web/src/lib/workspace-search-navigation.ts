import type { WorkspaceSearchTarget } from '@use-brian/shared'
import { brainRowUrl } from './brain-deep-link'
const searchBrainPrimitive = { memories:'memory',people:'contact',companies:'company',deals:'deal',entities:'entity',tasks:'task',files:'workspace_file' } as const
export function workspaceSearchHref(workspaceId:string,target:WorkspaceSearchTarget):string {
  const base=`/w/${encodeURIComponent(workspaceId)}`,id=encodeURIComponent(target.id)
  switch(target.type) {
    case 'page':return `${base}/p/${id}`
    case 'knowledge':return `${base}/brain/entry/knowledge/${id}`
    case 'brain':return brainRowUrl('',workspaceId,target.id,searchBrainPrimitive[target.primitive])
    case 'record':return `${base}/records/${id}?type=${encodeURIComponent(target.entityTypeId)}`
    case 'recording':return `${base}/recordings/${id}${target.segmentIndex===undefined?'':`?segment=${target.segmentIndex}`}`
    case 'office':return `${base}/office/${id}${target.contextId?`?context=${encodeURIComponent(target.contextId)}`:''}`
    case 'conversation':return `${base}/chat?${new URLSearchParams({v:target.visibility==='owner'?'personal':'workspace',s:target.id})}`
    case 'workflow':return `${base}/workflow/${id}`
  }
}
/** Existing source-specific authenticated detail routes; no external targets. */
export function workspaceSearchDetailPath(workspaceId:string,target:WorkspaceSearchTarget):string|null {
  const id=encodeURIComponent(target.id),ws=encodeURIComponent(workspaceId)
  switch(target.type) {
    case 'page':return `/api/views/${id}`
    case 'knowledge':return `/api/brain/knowledge/${id}?workspaceId=${ws}`
    case 'brain':return `/api/brain-inbox/${ws}/${searchBrainPrimitive[target.primitive]}/${id}`
    case 'record':return null
    case 'recording':return `/api/recordings/${id}`
    case 'office':return `/api/office/artifacts/${id}`
    case 'conversation':return `/api/sessions/${id}/messages`
    case 'workflow':return `/api/workflows/${id}`
  }
}
