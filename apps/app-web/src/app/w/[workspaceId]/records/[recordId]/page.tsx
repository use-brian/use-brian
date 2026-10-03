"use client";

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useT } from '@/lib/i18n/client'
import { readWorkspaceSearchItem, type SearchItemPreview } from '@/lib/api/workspace-search'
import { SURFACE_CACHE_SPINE_EVENTS } from '@/lib/surface-cache-invalidation'

/** Canonical read-only destination for custom/operator records without an editor route. */
export default function WorkspaceRecordPage() {
  const {workspaceId,recordId}=useParams<{workspaceId:string;recordId:string}>(),t=useT().workspaceSearch
  const [record,setRecord]=useState<SearchItemPreview|null>(null),[failed,setFailed]=useState(false),[revision,setRevision]=useState(0)
  useEffect(()=>{
    const invalidate=(event:Event)=>{const detail=(event as CustomEvent<{workspaceId?:string}>).detail;if(detail?.workspaceId&&detail.workspaceId!==workspaceId)return;setRecord(null);setRevision(value=>value+1)}
    for(const event of SURFACE_CACHE_SPINE_EVENTS)window.addEventListener(event,invalidate)
    return()=>{for(const event of SURFACE_CACHE_SPINE_EVENTS)window.removeEventListener(event,invalidate)}
  },[workspaceId])
  useEffect(()=>{
    const controller=new AbortController();setRecord(null);setFailed(false)
    void readWorkspaceSearchItem(workspaceId,'records',`record:${recordId}`,controller.signal)
      .then(value=>{if(!controller.signal.aborted)setRecord(value)})
      .catch(()=>{if(!controller.signal.aborted)setFailed(true)})
    return()=>controller.abort()
  },[workspaceId,recordId,revision])
  return <main className="min-h-0 flex-1 overflow-y-auto p-6"><article className="mx-auto max-w-3xl space-y-4">
    <p className="text-sm text-muted-foreground">{t.recordTitle}</p>
    {failed?<p role="status">{t.unavailable}</p>:record?<><h1 className="break-words text-2xl font-semibold">{record.title}</h1><p className="whitespace-pre-wrap break-words">{record.text}</p></>:<div aria-busy="true" className="h-24 animate-pulse rounded-lg bg-muted" />}
  </article></main>
}
