"use client";

import { useEffect, useRef, useState } from 'react';
import { evictSurfaceCacheKey, readSurfaceCache, SurfaceCacheEvictionError } from './surface-cache';

export type ProtectedProjection<T> = T & { projectionDeadline: number; projectionMonotonicDeadline: number };

/** The full request time is subtracted conservatively, independently of server clock offset. */
export function protectProjection<T extends {validForMs:number}>(data:T,requestStarted:number):ProtectedProjection<T> {
  const now=performance.now();
  const remaining=Math.min(data.validForMs,30_000)-(now-requestStarted);
  if(!Number.isFinite(remaining)||remaining<=0)throw new SurfaceCacheEvictionError(new Error('projection_expired'));
  return {...data,projectionDeadline:Date.now()+remaining,projectionMonotonicDeadline:now+remaining};
}

export function projectionRemainingMs(data:ProtectedProjection<unknown>):number {
  return Math.min(data.projectionDeadline-Date.now(),data.projectionMonotonicDeadline-performance.now());
}

/** Expired cached data is hidden on the first render, before the refresh effect.
 * `purgeOnForeground` is for downloaded BYTES (doc/Office media): those clear
 * on focus and visibility return even inside their deadline. Metadata
 * projections revalidate behind the still-live value instead. */
export function useProtectedProjection<T>(key:string|null,data:ProtectedProjection<T>|undefined,onPurge:()=>void,refresh?:()=>Promise<unknown>,options?:{purgeOnForeground?:boolean}):ProtectedProjection<T>|undefined {
  const purgeOnForeground=options?.purgeOnForeground===true;
  const purgeRef=useRef(onPurge);
  purgeRef.current=onPurge;
  const refreshRef=useRef(refresh);refreshRef.current=refresh;
  // Renewed TTLs alone must not throw away an administrator's unfinished form.
  // Any changed authorized metadata hides the old selection for this render,
  // then clears it before exposing the new projection.
  const fingerprint=data?JSON.stringify(Object.fromEntries(Object.entries(data).filter(([field])=>!['validForMs','projectionDeadline','projectionMonotonicDeadline'].includes(field)))):null;
  const identity=fingerprint===null?null:`${key}:${fingerprint}`;
  const [accepted,setAccepted]=useState(identity);
  useEffect(()=>{
    if(accepted===identity)return;
    if(accepted!==null)purgeRef.current();
    setAccepted(identity);
  },[accepted,identity]);
  useEffect(()=>{
    if (!key) return;
    // Foreground entry revalidates rather than blanking: a projection still
    // inside its own deadline stays painted while the fresh one loads (a
    // changed one then purges selections through the identity check above),
    // and a failed refresh cannot extend that deadline. Only an expired or
    // non-renewable projection is dropped. Read the live slot, not a
    // render-time closure: expiry may have cleared it since the last render.
    const revalidate=()=>{
      const current=readSurfaceCache<ProtectedProjection<unknown>>(key).data;
      const live=current!==undefined&&projectionRemainingMs(current)>0;
      if(purgeOnForeground||!live||!refreshRef.current){purgeRef.current();evictSurfaceCacheKey(key,{keepInflight:!purgeOnForeground});}
      if(refreshRef.current)void refreshRef.current().catch(()=>{});
    };
    const visible=()=>{if(document.visibilityState==='visible')revalidate();};
    window.addEventListener('focus',revalidate);
    document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('focus',revalidate);document.removeEventListener('visibilitychange',visible);};
  },[key,purgeOnForeground]);
  useEffect(()=>{
    if(!key||!data)return;
    const ttl=projectionRemainingMs(data);
    if(!Number.isFinite(ttl)||ttl<=0){purgeRef.current();evictSurfaceCacheKey(key,{keepInflight:!purgeOnForeground});return;}
    const renew=refreshRef.current&&ttl>1_000?setTimeout(()=>{
      void refreshRef.current?.().catch(()=>{});
    },Math.max(500,Math.ceil(ttl-Math.min(5_000,ttl/2)))):undefined;
    const timeout=setTimeout(()=>{purgeRef.current();evictSurfaceCacheKey(key,{keepInflight:!purgeOnForeground});},Math.ceil(ttl));
    return()=>{clearTimeout(timeout);if(renew!==undefined)clearTimeout(renew);};
  },[key,data,purgeOnForeground]);
  return key&&data&&projectionRemainingMs(data)>0&&accepted===identity?data:undefined;
}
