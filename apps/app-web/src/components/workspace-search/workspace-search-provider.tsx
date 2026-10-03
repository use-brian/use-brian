"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import { usePathname } from 'next/navigation'
import { useT } from '@/lib/i18n/client'
import { requestSidebarClose } from '@/lib/sidebar-close'
import { WorkspaceSearchDialog } from './workspace-search-dialog'

type SearchContext = { register(element: HTMLElement): () => void; setFallback(element: HTMLDivElement | null): void; hasSlot: boolean }
const Context=createContext<SearchContext|null>(null)

/** A real flex child reserves width; the provider portals exactly one trigger. */
export function WorkspaceSearchSlot() {
  const context=useContext(Context), ref=useRef<HTMLDivElement>(null)
  const register=context?.register
  useEffect(()=>ref.current && register ? register(ref.current) : undefined,[register])
  return <div ref={ref} data-workspace-search-slot className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center self-center" />
}

/** Custom routes without standard topbars still reserve a normal-flow action row. */
export function WorkspaceSearchFallback() {
  const context=useContext(Context)
  return <div hidden={context?.hasSlot ?? true} data-workspace-search-fallback data-doc-chrome
    className="h-11 shrink-0 border-b bg-background pl-14 text-right"
    style={{paddingRight:'env(safe-area-inset-right)'}}>
    <div ref={context?.setFallback} className="ml-auto h-11 w-11" />
  </div>
}

export function WorkspaceSearchProvider({workspaceId,children}:{workspaceId:string;children:ReactNode}) {
  const t=useT().workspaceSearch, pathname=usePathname()
  const [open,setOpen]=useState(false), [slot,setSlot]=useState<HTMLElement|null>(null), [fallback,setFallback]=useState<HTMLDivElement|null>(null)
  const slots=useRef(new Set<HTMLElement>()), button=useRef<HTMLButtonElement>(null), restore=useRef<HTMLElement|null>(null)
  const register=useCallback((element:HTMLElement)=>{
    slots.current.add(element);setSlot(element)
    return ()=>{slots.current.delete(element);setSlot([...slots.current].filter(node=>node.isConnected).at(-1)??null)}
  },[])
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
  return <Context.Provider value={{register,setFallback,hasSlot:!!slot}}>
    {children}
    {destination && createPortal(<button ref={button} type="button" aria-label={t.title} title={t.shortcut}
      onClick={openSearch} data-workspace-search-trigger
      style={{WebkitAppRegion:'no-drag'} as React.CSSProperties}
      className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      <Search className="size-4" aria-hidden />
    </button>,destination)}
    <WorkspaceSearchDialog key={workspaceId} workspaceId={workspaceId} open={open} onClose={close} />
  </Context.Provider>
}
