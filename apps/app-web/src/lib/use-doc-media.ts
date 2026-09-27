"use client";

/** Protected durable media shares the surface cache. [COMP:app-web/doc-file-url] */
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {fetchDocMediaProjection,resolveFileRefUrl,type FileRef,type DocMediaProjection} from '@/components/doc/doc-file-url';
import {invalidateSurfaceCache,useCachedResource} from './surface-cache';
import {docMediaCacheKey} from './surface-prefetch';
import {useProtectedProjection} from './use-protected-projection';
import {useOptionalWorkspaceContext} from './workspace-context';

const lifecycle={
  dispose:(value:DocMediaProjection)=>URL.revokeObjectURL(value.url),
  expiresInMs:(value:DocMediaProjection)=>Math.min(value.projectionDeadline-Date.now(),value.projectionMonotonicDeadline-performance.now()),
};

export function useDocMediaSrc(workspaceId:string|null,fileId:string|null):string|null {
  const workspace=useOptionalWorkspaceContext();
  const key=workspaceId&&fileId&&workspace?.workspaceId===workspaceId&&workspace.me.id
    ?docMediaCacheKey(workspaceId,workspace.me.id,fileId):null;
  const previous=useRef(key);
  useLayoutEffect(()=>{
    if(previous.current&&previous.current!==key)invalidateSurfaceCache(previous.current);
    previous.current=key;
  },[key]);
  const cache=useCachedResource(key,()=>fetchDocMediaProjection(workspaceId!,fileId!),lifecycle);
  const projection=useProtectedProjection(key??'doc-media:disabled',cache.data,()=>{},cache.refresh);
  return projection?.url??null;
}

/** Legacy cache previews remain separately audited; never reuse a prior source. */
export function useFileRefSrc(ref:FileRef|null,workspaceId:string):string|null {
  const durable=useDocMediaSrc(workspaceId,ref?.bucket==='workspace_files'?ref.path:null);
  const workspace=useOptionalWorkspaceContext();
  const legacyKey=ref?.bucket==='file_cache'&&workspace?.workspaceId===workspaceId
    ?`${workspaceId}:${workspace.me.id}:${ref.path}`:null;
  const [legacy,setLegacy]=useState<{key:string;url:string|null}|null>(null);
  useEffect(()=>{
    if(!legacyKey||!ref)return;
    let active=true;
    void resolveFileRefUrl(ref,workspaceId).then(url=>{if(active)setLegacy({key:legacyKey,url});});
    return()=>{active=false;};
  },[legacyKey,ref,workspaceId]);
  return ref?.bucket==='workspace_files'?durable:legacyKey&&legacy?.key===legacyKey?legacy.url:null;
}
