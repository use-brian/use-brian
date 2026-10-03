"use client";

import { useEffect, useId, useRef, useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { ArrowLeft, ArrowUpRight, Search, Send, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { WORKSPACE_SEARCH_FAMILIES, type WorkspaceSearchFamily, type WorkspaceSearchItem, type WorkspaceSearchResponse } from '@use-brian/shared'
import { useT, format } from '@/lib/i18n/client'
import { useWorkspaceContext } from '@/lib/workspace-context'
import { usePrimaryAssistant } from '@/contexts/primary-assistant'
import { listWorkspaceAssistants, type WorkspaceAssistantSummary } from '@/lib/api/views'
import { readActiveAssistantId, resolveDraftAssistantId } from '@/lib/active-assistant'
import { ASSISTANT_REFRESH_EVENT } from '@/lib/assistant-events'
import { SURFACE_CACHE_SPINE_EVENTS } from '@/lib/surface-cache-invalidation'
import { searchWorkspace, previewWorkspaceSearchItem, type SearchItemPreview } from '@/lib/api/workspace-search'
import { selectWorkspaceSearchAction, type SearchSelection } from '@/lib/workspace-search-selection'
import { workspaceSearchHref } from '@/lib/workspace-search-navigation'
import { personalChatHandoffPath, stashChatHandoff } from '@/lib/chat-handoff'

export function WorkspaceSearchDialog({workspaceId,open,onClose}:{workspaceId:string;open:boolean;onClose():void}) {
  const copy=useT(),t=copy.workspaceSearch, workspace=useWorkspaceContext(), primary=usePrimaryAssistant(),router=useRouter()
  const [query,setQuery]=useState(''),[kind,setKind]=useState<WorkspaceSearchFamily|undefined>(),[revision,setRevision]=useState(0)
  const [result,setResult]=useState<WorkspaceSearchResponse|null>(null),[state,setState]=useState<'loading'|'error'|'partial'|'complete'>('complete')
  const [selection,setSelection]=useState<SearchSelection>({key:null,deliberate:false})
  const [preview,setPreview]=useState<SearchItemPreview|null>(null),[previewError,setPreviewError]=useState(false),[phonePreview,setPhonePreview]=useState(false)
  const [roster,setRoster]=useState<WorkspaceAssistantSummary[]|null>(null),[recipient,setRecipient]=useState<WorkspaceAssistantSummary|null>(null)
  const [sending,setSending]=useState(false),[opening,setOpening]=useState(false),[more,setMore]=useState(false)
  const input=useRef<HTMLInputElement>(null),generation=useRef(0),submission=useRef(false), mounted=useRef(true),listId=useId()
  const paginationAbort=useRef<AbortController|null>(null)
  const currentItem=result?.items.find(item=>item.key===selection.key)
  const resolve=(list:WorkspaceAssistantSummary[])=>{
    const id=resolveDraftAssistantId({persisted:readActiveAssistantId(workspaceId),primary:primary.assistantId,roster:list})
    return list.find(item=>item.id===id)??null
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++}},[])
  useEffect(()=>{
    if (!open) return
    let active=true
    const refresh=()=>{setRoster(null);setRecipient(null);void listWorkspaceAssistants(workspaceId).then(list=>{if(active){setRoster(list);setRecipient(resolve(list))}}).catch(()=>{if(active)setRoster([])})}
    refresh();window.addEventListener(ASSISTANT_REFRESH_EVENT,refresh)
    return()=>{active=false;window.removeEventListener(ASSISTANT_REFRESH_EVENT,refresh)}
    // Roster is always loaded anew when opening or after an authority signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[open,workspaceId,primary.assistantId])
  const invalidate=()=>{paginationAbort.current?.abort();generation.current++;setResult(null);setPreview(null);setPreviewError(false);setSelection({key:null,deliberate:false});setState('loading');setPhonePreview(false)}
  useEffect(()=>{
    if (!open) return
    const changed=(event:Event)=>{
      const detail=(event as CustomEvent<{workspaceId?:string}>).detail
      if (detail?.workspaceId && detail.workspaceId!==workspaceId) return
      invalidate();setRevision(value=>value+1)
    }
    const events=[...SURFACE_CACHE_SPINE_EVENTS,'doc:local-pages-changed','doc:page-updated','office:artifacts-changed','sidan:chat-sessions-refresh']
    for(const event of events)window.addEventListener(event,changed)
    window.addEventListener('focus',changed)
    return()=>{for(const event of events)window.removeEventListener(event,changed);window.removeEventListener('focus',changed)}
  },[open,workspaceId])
  useEffect(()=>{
    const identity=++generation.current,controller=new AbortController()
    setPreview(null);setPreviewError(false);setResult(null);setSelection({key:null,deliberate:false});setPhonePreview(false)
    if (!open || !query.trim()) {setState('complete');return()=>controller.abort()}
    setState('loading')
    const timer=setTimeout(()=>{void searchWorkspace(workspaceId,{q:query,kind},controller.signal).then(data=>{
      if(controller.signal.aborted||identity!==generation.current)return
      setResult(data);setState(data.completeness)
    }).catch(()=>{if(!controller.signal.aborted&&identity===generation.current)setState('error')})},200)
    return()=>{clearTimeout(timer);controller.abort();paginationAbort.current?.abort()}
  },[open,workspaceId,query,kind,revision])
  useEffect(()=>{
    setSelection(previous=>selectWorkspaceSearchAction({items:result?.items??[],state,previous,askAvailable:!!recipient&&!!query.trim()}))
  },[result,state,recipient,query])
  useEffect(()=>{
    setPreview(null);setPreviewError(false)
    if (!open||!currentItem) return
    const controller=new AbortController(),identity=generation.current
    void previewWorkspaceSearchItem(workspaceId,currentItem,controller.signal).then(value=>{
      if(!controller.signal.aborted&&identity===generation.current)setPreview(value)
    }).catch(()=>{
      if(!controller.signal.aborted&&identity===generation.current){setPreviewError(true);setState('error');setResult(previous=>previous?{...previous,items:previous.items.filter(item=>item.key!==currentItem.key)}:null);setSelection({key:null,deliberate:true})}
    })
    return()=>controller.abort()
  },[open,currentItem,workspaceId])
  const choose=(key:string)=>setSelection({key,deliberate:true})
  const ask=async()=>{
    if(submission.current||!recipient||!query.trim()||state==='loading')return
    submission.current=true;setSending(true)
    try {
      const list=await listWorkspaceAssistants(workspaceId)
      if(!mounted.current)return
      const current=resolve(list);setRoster(list);setRecipient(current)
      if(current?.id!==recipient.id)return // Show the repaired recipient before another explicit submission.
      stashChatHandoff({workspaceId,assistantId:current.id,text:query,ts:Date.now()})
      router.push(personalChatHandoffPath(workspaceId,current.id));onClose();setQuery('')
    } catch {if(mounted.current){setRoster([]);setRecipient(null)}}
    finally {submission.current=false;if(mounted.current)setSending(false)}
  }
  const openItem=async(item:WorkspaceSearchItem)=>{
    if(submission.current)return
    submission.current=true;setOpening(true)
    const controller=new AbortController(),identity=generation.current
    try {
      const current=await previewWorkspaceSearchItem(workspaceId,item,controller.signal)
      if(!mounted.current||identity!==generation.current)return
      router.push(workspaceSearchHref(workspaceId,current.target));onClose()
    } catch {if(mounted.current){setPreview(null);setPreviewError(true);setState('error');setResult(previous=>previous?{...previous,items:previous.items.filter(row=>row.key!==item.key)}:null);setSelection({key:null,deliberate:true})}}
    finally{submission.current=false;if(mounted.current)setOpening(false)}
  }
  const activate=()=>{if(state==='loading'||sending||opening)return;if(selection.key==='ask')void ask();else if(currentItem)void openItem(currentItem)}
  const loadMore=async()=>{
    if(!result?.nextCursor||more)return
    const identity=generation.current,controller=new AbortController();paginationAbort.current=controller;setMore(true)
    try{const data=await searchWorkspace(workspaceId,{q:query,kind,cursor:result.nextCursor},controller.signal)
      if(identity===generation.current)setResult(previous=>({...data,items:[...(previous?.items??[]),...data.items.filter(item=>!previous?.items.some(row=>row.key===item.key))]}))
      if(identity===generation.current)setState(data.completeness)
    }catch{if(identity===generation.current)setState('error')}finally{if(mounted.current)setMore(false)}
  }
  const keys=[...(result?.items.map(item=>item.key)??[]),...(recipient&&query.trim()?['ask']:[])]
  const optionId=(key:string)=>`${listId}-${encodeURIComponent(key)}`
  const previewPanel=<section aria-label={t.preview} className={`${phonePreview?'flex':'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4`}>
    <button type="button" onClick={()=>setPhonePreview(false)} className="inline-flex min-h-11 items-center gap-2 self-start md:hidden"><ArrowLeft className="size-4" />{t.back}</button>
    {previewError?<p role="status">{t.unavailable}</p>:currentItem?<>
      <h3 className="break-words text-lg font-semibold">{preview?.title??currentItem.title}</h3>
      <p className="text-xs text-muted-foreground">{t.families[currentItem.kind]}{currentItem.updatedAt?` · ${new Date(currentItem.updatedAt).toLocaleDateString()}`:''}</p>
      <p className="whitespace-pre-wrap break-words text-sm">{preview?.text??currentItem.snippet}</p>
      <button type="button" disabled={!preview||opening} onClick={()=>void openItem(currentItem)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">{t.open}<ArrowUpRight className="size-4" /></button>
    </>:<p className="text-sm text-muted-foreground">{selection.key==='ask'?t.privateHint:t.selectPreview}</p>}
  </section>
  return <Dialog.Root open={open} onOpenChange={value=>{if(!value)onClose()}}>
    <Dialog.Portal><Dialog.Backdrop className="fixed inset-0 z-50 bg-black/35 backdrop-blur-sm" />
      <Dialog.Popup data-workspace-search-dialog initialFocus={input}
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
        onKeyDown={event=>{
          if(event.nativeEvent.isComposing||event.repeat)return
          if(event.target!==input.current)return
          if(event.key==='ArrowDown'||event.key==='ArrowUp'){
            if(state==='loading'||!keys.length)return
            event.preventDefault();const index=keys.indexOf(selection.key??'');choose(keys[(index+(event.key==='ArrowDown'?1:keys.length-1)+keys.length)%keys.length]!)
          }else if(event.key==='Enter'){event.preventDefault();activate()}
        }}>
        <Dialog.Title className="sr-only">{t.title}</Dialog.Title>
        <Dialog.Description className="sr-only">{t.blank}</Dialog.Description>
        <div className="flex shrink-0 items-center gap-2 border-b px-3">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input ref={input} data-workspace-search-input role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls={listId}
            aria-activedescendant={selection.key?optionId(selection.key):undefined} aria-label={format(t.placeholder,{workspace:workspace?.name??''})}
            value={query} maxLength={500} onChange={event=>{invalidate();setQuery(event.target.value)}} placeholder={format(t.placeholder,{workspace:workspace?.name??''})}
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none" />
          <button type="button" onClick={onClose} aria-label={t.close} className="inline-flex size-11 shrink-0 items-center justify-center rounded hover:bg-muted"><X className="size-4" /></button>
        </div>
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b p-2" aria-label={t.title}>
          {[undefined,...WORKSPACE_SEARCH_FAMILIES].map(family=><button key={family??'all'} type="button" aria-pressed={family===kind} onClick={()=>{invalidate();setKind(family)}} className={`min-h-11 shrink-0 rounded-md px-3 text-sm ${family===kind?'bg-accent font-medium':'text-muted-foreground hover:bg-muted'}`}>{family?t.families[family]:t.all}</button>)}
        </div>
        <div className="flex min-h-0 flex-1 md:min-h-80">
          <div className={`${phonePreview?'hidden md:block':''} min-h-0 w-full overflow-y-auto p-2 md:w-1/2 md:border-r`}>
            {!query.trim()?<p className="p-4 text-sm text-muted-foreground">{t.blank}</p>:<>
              {state==='loading'?<p role="status" className="p-3 text-sm">{t.loading}</p>:null}
              {(state==='error'||state==='partial')&&<div role="status" className="p-3 text-sm"><p>{state==='partial'?t.partial:t.error}</p><button type="button" className="min-h-11 underline" onClick={()=>{invalidate();setRevision(value=>value+1)}}>{t.retry}</button></div>}
              {state==='complete'&&result?.items.length===0&&<p className="p-3 text-sm text-muted-foreground">{t.empty}</p>}
              <div role="listbox" id={listId} aria-label={t.title}>
                {(result?.items??[]).map(item=><div key={item.key} role="option" id={optionId(item.key)} aria-selected={selection.key===item.key} onMouseDown={()=>choose(item.key)} className={`mb-1 rounded-lg ${selection.key===item.key?'bg-accent':''}`}>
                  <button type="button" className="block min-h-11 w-full rounded-lg p-3 text-left hover:bg-muted" onFocus={()=>choose(item.key)} onClick={()=>{choose(item.key);void openItem(item)}}>
                    <span className="block truncate text-sm font-medium">{item.title}</span><span className="block truncate text-xs text-muted-foreground">{t.families[item.kind]}{item.status && item.status in copy.brainPage.taskStatus ? ` · ${copy.brainPage.taskStatus[item.status as keyof typeof copy.brainPage.taskStatus]}` : ''} · {item.snippet}</span>
                  </button>
                  <button type="button" className="min-h-11 px-3 text-sm underline md:hidden" onClick={()=>{choose(item.key);setPhonePreview(true)}}>{t.preview}</button>
                </div>)}
                <div role="option" id={optionId('ask')} aria-selected={selection.key==='ask'} className={`rounded-lg ${selection.key==='ask'?'bg-accent':''}`}>
                  <button type="button" disabled={!recipient||state==='loading'||sending} onFocus={()=>choose('ask')} onClick={()=>{choose('ask');void ask()}} className="flex min-h-11 w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-muted disabled:opacity-50">
                    <Send className="size-4 shrink-0"/><span><span className="block text-sm font-medium">{recipient?format(t.ask,{assistant:recipient.name}):roster===null?t.assistantLoading:t.noAssistant}</span><span className="block text-xs text-muted-foreground">{t.privateHint}</span></span>
                  </button>
                </div>
              </div>
              {roster!==null&&!recipient&&<button type="button" className="min-h-11 px-3 text-sm underline" onClick={()=>{router.push(`/w/${workspaceId}/studio/assistants`);onClose()}}>{t.setup}</button>}
              {result?.nextCursor&&<button type="button" disabled={more||state==='loading'} className="min-h-11 w-full text-sm underline" onClick={()=>void loadMore()}>{t.more}</button>}
            </>}
          </div>
          {previewPanel}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
