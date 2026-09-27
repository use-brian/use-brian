"use client";

/** Protected durable media shares the surface cache. [COMP:app-web/doc-file-url] */
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {fetchDocMediaProjection,resolveFileRefUrl,type FileRef,type DocMediaProjection} from '@/components/doc/doc-file-url';
import {invalidateSurfaceCache,loadSurfaceCache,readSurfaceCache,useCachedResource} from './surface-cache';
import {docMediaCacheKey} from './surface-prefetch';
import {useProtectedProjection} from './use-protected-projection';
import {useOptionalWorkspaceContext} from './workspace-context';

const lifecycle={
  dispose:(value:DocMediaProjection)=>URL.revokeObjectURL(value.url),
  expiresInMs:(value:DocMediaProjection)=>Math.min(value.projectionDeadline-Date.now(),value.projectionMonotonicDeadline-performance.now()),
};

export function useDocMedia(workspaceId:string|null,fileId:string|null) {
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
  return {url:projection?.url??null,mimeType:projection?.mimeType??null,
    loading:!!key&&!projection&&!cache.error,error:cache.error};
}

export function useDocMediaSrc(workspaceId:string|null,fileId:string|null):string|null {
  return useDocMedia(workspaceId,fileId).url;
}

/** A deliberate download must still belong to its initiating viewer on arrival. */
export function useDocMediaDownload(workspaceId:string) {
  const workspace=useOptionalWorkspaceContext();
  const prefix=workspace?.workspaceId===workspaceId&&workspace.me.id
    ?docMediaCacheKey(workspaceId,workspace.me.id,''):null;
  const owner=useMemo(()=>({prefix,active:false,pending:new Set<string>()}),[prefix]);
  const current=useRef(owner);current.current=owner;
  const previous=useRef(prefix);
  useLayoutEffect(()=>{
    if(previous.current&&previous.current!==prefix)invalidateSurfaceCache(previous.current);
    previous.current=prefix;
    owner.active=true;
    const cancel=()=>{for(const key of owner.pending)invalidateSurfaceCache(key);};
    const visible=()=>{if(document.visibilityState==='visible')cancel();};
    window.addEventListener('focus',cancel);
    document.addEventListener('visibilitychange',visible);
    return()=>{
      owner.active=false;cancel();
      window.removeEventListener('focus',cancel);
      document.removeEventListener('visibilitychange',visible);
    };
  },[prefix,owner]);
  return useCallback(async(fileId:string,name:string)=>{
    if(!owner.prefix||!owner.active||current.current!==owner)throw new Error('media_identity_changed');
    const key=owner.prefix+fileId;
    owner.pending.add(key);
    try {
      const value=await loadSurfaceCache(key,()=>fetchDocMediaProjection(workspaceId,fileId),lifecycle);
      if(!value||!owner.active||current.current!==owner||readSurfaceCache(key).data!==value||lifecycle.expiresInMs(value)<=0)
        throw new Error('media_download_no_longer_authorized');
      const anchor=document.createElement('a');
      anchor.href=value.url;anchor.download=name;
      document.body.appendChild(anchor);
      try {anchor.click();} finally {anchor.remove();}
    } finally {owner.pending.delete(key);}
  },[owner,workspaceId]);
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
