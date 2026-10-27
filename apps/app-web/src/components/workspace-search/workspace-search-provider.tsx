"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useT } from '@/lib/i18n/client'
import { requestSidebarClose } from '@/lib/sidebar-close'
import { WorkspaceSearchDialog } from './workspace-search-dialog'

type SearchPlacement = 'toolbar' | 'sidebar'
type SearchContext = { register(element: HTMLElement, placement: SearchPlacement): () => void; setFallback(element: HTMLDivElement | null): void; hasSlot: boolean; sidebarSelected: boolean }
const Context=createContext<SearchContext|null>(null)

/** A real flex child reserves width; the provider portals exactly one trigger. */
export function WorkspaceSearchSlot({placement='toolbar'}:{placement?:SearchPlacement}) {
  const context=useContext(Context), ref=useRef<HTMLDivElement>(null)
  const register=context?.register
  useEffect(()=>ref.current && register ? register(ref.current,placement) : undefined,[register,placement])
  return <div ref={ref} data-workspace-search-slot data-workspace-search-placement={placement}
    style={placement==='toolbar' && context?.sidebarSelected ? {display:'none'} : undefined}
    className={placement==='sidebar' ? "flex size-8 shrink-0 items-center justify-center" : "ml-auto flex h-11 w-11 shrink-0 items-center justify-center self-center md:size-8"} />
}

/** Custom routes without standard topbars still reserve a normal-flow action row. */
export function WorkspaceSearchFallback() {
  const context=useContext(Context)
  return <div hidden={context?.hasSlot ?? true} data-workspace-search-fallback data-doc-chrome
    className="flex h-11 shrink-0 items-center border-b bg-background pl-14 text-right md:h-12 md:px-4"
    style={{paddingRight:'max(env(safe-area-inset-right), var(--doc-titlebar-controls, 0px))'}}>
    <div ref={context?.setFallback} className="ml-auto h-11 w-11 md:size-8" />
  </div>
}

export function WorkspaceSearchProvider({workspaceId,children}:{workspaceId:string;children:ReactNode}) {
  const t=useT().workspaceSearch, pathname=usePathname()
  const [open,setOpen]=useState(false), [slot,setSlot]=useState<HTMLElement|null>(null), [fallback,setFallback]=useState<HTMLDivElement|null>(null)
  const [desktop,setDesktop]=useState(false)
  useEffect(()=>{
    if (typeof window.matchMedia!=='function') return
    const media=window.matchMedia('(min-width: 768px)'), update=()=>setDesktop(media.matches)
    update();media.addEventListener('change',update)
    return ()=>media.removeEventListener('change',update)
  },[])
  const slots=useRef(new Map<HTMLElement,SearchPlacement>()), button=useRef<HTMLButtonElement>(null), restore=useRef<HTMLElement|null>(null)
  const register=useCallback((element:HTMLElement,placement:SearchPlacement)=>{
    const select=()=>{
      const entries=[...slots.current].filter(([node])=>node.isConnected)
      setSlot((desktop ? entries.findLast(([,kind])=>kind==='sidebar')?.[0] : null) ?? entries.findLast(([,kind])=>kind==='toolbar')?.[0] ?? null)
    }
    slots.current.set(element,placement);select()
    return ()=>{slots.current.delete(element);select()}
  },[desktop])
  const openSearch=useCallback(()=>{
    const blocking=[...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"]')]
      .some(node=>!node.hasAttribute('data-workspace-search-dialog') && !node.closest('[aria-hidden="true"], [inert], [hidden]') && node.getClientRects().length>0)
    if (blocking) return false
    if (!open) restore.current=document.activeElement instanceof HTMLElement ? document.activeElement : button.current
    requestSidebarClose();setOpen(true)
    document.querySelector<HTMLInputElement>('[data-workspace-search-input]')?.focus()
    return true
  },[open])
  useEffect(()=>{
    const onKey=(event:KeyboardEvent)=>{
      if (event.isComposing || event.repeat || event.shiftKey || event.altKey || !(event.metaKey||event.ctrlKey) || event.key.toLowerCase()!=='k') return
      if (openSearch()) {event.preventDefault();event.stopImmediatePropagation()}
    }
    window.addEventListener('keydown',onKey,true)
    return ()=>window.removeEventListener('keydown',onKey,true)
  },[openSearch])
  useEffect(()=>{setOpen(false)},[workspaceId])
  useEffect(()=>{if (!pathname?.startsWith(`/w/${workspaceId}/`)) setOpen(false)},[pathname,workspaceId])
  const close=()=>{setOpen(false);requestAnimationFrame(()=>{const target=restore.current?.isConnected?restore.current:button.current;target?.focus()})}
  const destination=slot??fallback
  const sidebarSelected=slot?.dataset.workspaceSearchPlacement==='sidebar'
  return <Context.Provider value={{register,setFallback,hasSlot:!!slot,sidebarSelected}}>
    {children}
    {destination && createPortal(<button ref={button} type="button" aria-label={t.title} title={t.shortcut}
      onClick={openSearch} data-workspace-search-trigger
      style={{WebkitAppRegion:'no-drag'} as React.CSSProperties}
      className={`inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring md:size-8`}>
      <Search className={sidebarSelected ? "size-[18px]" : "size-4"} aria-hidden />
    </button>,destination)}
    <WorkspaceSearchDialog key={workspaceId} workspaceId={workspaceId} open={open} onClose={close} />
  </Context.Provider>
}
