"use client";

import { useEffect, useRef, useState } from 'react';
import { invalidateSurfaceCache, SurfaceCacheEvictionError } from './surface-cache';

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

/** Expired cached data is hidden on the first render, before the refresh effect. */
export function useProtectedProjection<T>(key:string|null,data:ProtectedProjection<T>|undefined,onPurge:()=>void,refresh?:()=>Promise<unknown>):ProtectedProjection<T>|undefined {
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
    const purge=()=>{purgeRef.current();invalidateSurfaceCache(key);};
    const visible=()=>{if(document.visibilityState==='visible')purge();};
    window.addEventListener('focus',purge);
    document.addEventListener('visibilitychange',visible);
    return()=>{window.removeEventListener('focus',purge);document.removeEventListener('visibilitychange',visible);};
  },[key]);
  useEffect(()=>{
    if(!key||!data)return;
    const ttl=projectionRemainingMs(data);
    if(!Number.isFinite(ttl)||ttl<=0){purgeRef.current();invalidateSurfaceCache(key);return;}
    const renew=refreshRef.current&&ttl>1_000?setTimeout(()=>{
      void refreshRef.current?.().catch(()=>{});
    },Math.max(500,Math.ceil(ttl-Math.min(5_000,ttl/2)))):undefined;
    const timeout=setTimeout(()=>{purgeRef.current();invalidateSurfaceCache(key);},Math.ceil(ttl));
    return()=>{clearTimeout(timeout);if(renew!==undefined)clearTimeout(renew);};
  },[key,data]);
  return key&&data&&projectionRemainingMs(data)>0&&accepted===identity?data:undefined;
}
