"use client";

import { useEffect, useRef, useState } from 'react'
import { CHAT_HANDOFF_EVENT, takeChatHandoff, isPendingChatHandoffFresh, resolveChatHandoffAction, type PendingChatHandoff } from './chat-handoff'

type Ports = {
  workspaceId:string; assistantsLoaded:boolean; blocked:boolean;
  activeSessionId:string|null; activeAssistantId:string|null; view:'personal'|'workspace';
  prepare(handoff:PendingChatHandoff):void;
  validateAssistant(id:string):Promise<boolean>;
  send(handoff:PendingChatHandoff):Promise<boolean>;
  prefill(handoff:PendingChatHandoff):void;
  preserveUnsent?(handoff:PendingChatHandoff):void;
}
/** Same hook drives the mounted Chat consumer and its strict-mode transition tests. */
export function useChatHandoff(ports:Ports) {
  const latest=useRef(ports);latest.current=ports
  const [queue,setQueue]=useState<PendingChatHandoff[]>([]),[prepared,setPrepared]=useState<string|null>(null)
  const pendingOnExit=useRef(queue);pendingOnExit.current=queue
  const activeLaunch=useRef<string|null>(null)
  const preparing=useRef(new Set<string>()),submitted=useRef(new Set<string>())
  const identity=(handoff:PendingChatHandoff)=>handoff.requestId??`${handoff.workspaceId}:${handoff.assistantId}:${handoff.ts}`
  useEffect(()=>{
    const receive=(event?:Event)=>{
      const workspace=(event as CustomEvent<{workspaceId?:string}>|undefined)?.detail?.workspaceId
      if(workspace&&workspace!==ports.workspaceId)return
      const value=takeChatHandoff(ports.workspaceId,Date.now())
      if(value)setQueue(previous=>previous.some(row=>identity(row)===identity(value))||submitted.current.has(identity(value))?previous:[...previous,value])
    }
    receive();window.addEventListener(CHAT_HANDOFF_EVENT,receive)
    return()=>window.removeEventListener(CHAT_HANDOFF_EVENT,receive)
  },[ports.workspaceId])
  useEffect(()=>()=>{
    for(const handoff of pendingOnExit.current) if(!submitted.current.has(identity(handoff)))latest.current.preserveUnsent?.(handoff)
  },[])
  const handoff=queue[0],id=handoff?identity(handoff):null
  useEffect(()=>{
    if(!handoff||!id||ports.blocked||!ports.assistantsLoaded||preparing.current.has(id))return
    preparing.current.add(id);activeLaunch.current=id;latest.current.prepare(handoff);setPrepared(id)
  },[handoff,id,ports.blocked,ports.assistantsLoaded])
  useEffect(()=>{
    if(!handoff||!id||prepared!==id||ports.blocked||!ports.assistantsLoaded||ports.activeSessionId||ports.view!=='personal'||submitted.current.has(id))return
    let cancelled=false
    void latest.current.validateAssistant(handoff.assistantId).then(async accessible=>{
      if(cancelled||submitted.current.has(id))return
      const current=latest.current
      const action=resolveChatHandoffAction({handoff,assistantsLoaded:true,assistantIds:accessible?[handoff.assistantId]:[],activeAssistantId:current.activeAssistantId,activeSessionId:current.activeSessionId,view:current.view})
      if(action==='wait'||action==='drop')return
      submitted.current.add(id)
      // Consume before send: a refresh cannot replay an uncertain transport.
      setQueue(previous=>previous.filter(row=>identity(row)!==id));setPrepared(null)
      if(!accessible||!isPendingChatHandoffFresh(handoff,current.workspaceId,Date.now())){current.prefill(handoff);return}
      try {if(!await current.send(handoff) && activeLaunch.current===id) latest.current.prefill(handoff)}
      catch {if(activeLaunch.current===id)latest.current.prefill(handoff)}
    }).catch(()=>{
      if(cancelled||submitted.current.has(id))return
      submitted.current.add(id);setQueue(previous=>previous.filter(row=>identity(row)!==id));setPrepared(null);latest.current.prefill(handoff)
    })
    return()=>{cancelled=true}
  },[handoff,id,prepared,ports.blocked,ports.assistantsLoaded,ports.activeSessionId,ports.activeAssistantId,ports.view])
}
