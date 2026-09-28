"use client";

/** Protected durable media shares the surface cache. [COMP:app-web/doc-file-url] */
import {useCallback,useLayoutEffect,useMemo,useRef} from 'react';
import {fetchDocMediaProjection,fetchCachedMediaProjection,fetchOfficeMediaProjection,type FileRef,type DocMediaProjection} from '@/components/doc/doc-file-url';
import {invalidateSurfaceCache,loadSurfaceCache,readSurfaceCache,useCachedResource,SurfaceCacheEvictionError} from './surface-cache';
import {docMediaCacheKey,fileCacheMediaCacheKey,officeMediaCacheKey} from './surface-prefetch';
import {useProtectedProjection} from './use-protected-projection';
import {useOptionalWorkspaceContext} from './workspace-context';

const lifecycle={
  dispose:(value:DocMediaProjection)=>URL.revokeObjectURL(value.url),
  expiresInMs:(value:DocMediaProjection)=>Math.min(value.projectionDeadline-Date.now(),value.projectionMonotonicDeadline-performance.now()),
};

function useProtectedMedia(workspaceId:string|null,fileId:string|null,kind:'durable'|'original'|'pdf') {
  const workspace=useOptionalWorkspaceContext();
  const key=workspaceId&&fileId&&workspace?.workspaceId===workspaceId&&workspace.me.id
    ?kind==='durable'?docMediaCacheKey(workspaceId,workspace.me.id,fileId):fileCacheMediaCacheKey(workspaceId,workspace.me.id,fileId,kind):null;
  const previous=useRef(key);
  useLayoutEffect(()=>{
    if(previous.current&&previous.current!==key)invalidateSurfaceCache(previous.current);
    previous.current=key;
  },[key]);
  const cache=useCachedResource(key,()=>kind==='durable'?fetchDocMediaProjection(workspaceId!,fileId!):fetchCachedMediaProjection(workspaceId!,fileId!,kind),lifecycle);
  const projection=useProtectedProjection(key??'doc-media:disabled',cache.data,()=>{},cache.refresh);
  return {url:projection?.url??null,mimeType:projection?.mimeType??null,
    loading:!!key&&!projection&&!cache.error,error:cache.error};
}

export function useDocMedia(workspaceId:string|null,fileId:string|null) {
  return useProtectedMedia(workspaceId,fileId,'durable');
}

export function useFileCacheMedia(workspaceId:string|null,fileId:string|null,representation:'original'|'pdf'='original') {
  return useProtectedMedia(workspaceId,fileId,representation);
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

/** All supported refs share current identity, admission and cache ownership. */
export function useFileRefSrc(ref:FileRef|null,workspaceId:string):string|null {
  const known=ref?.bucket==='workspace_files'||ref?.bucket==='file_cache';
  return useProtectedMedia(workspaceId,known?ref!.path:null,ref?.bucket==='workspace_files'?'durable':'original').url;
}

/** All Office renderers use cache-owned URLs with the same protected lifetime. */
export function useOfficeResourceUrls(artifactId:string|null,resourceIds:readonly string[]) {
  const workspace=useOptionalWorkspaceContext();
  const ids=[...new Set(resourceIds)].sort();
  const key=workspace?.workspaceId&&workspace.me.id&&artifactId&&ids.length
    ?officeMediaCacheKey(workspace.workspaceId,workspace.me.id,artifactId,ids):null;
  const previous=useRef(key);
  useLayoutEffect(()=>{
    if(previous.current&&previous.current!==key)invalidateSurfaceCache(previous.current);
    previous.current=key;
  },[key]);
  const cache=useCachedResource(key,async()=>{
    const results=await Promise.allSettled(ids.map(id=>fetchOfficeMediaProjection(workspace!.workspaceId,artifactId!,id)));
    const admitted=results.flatMap((result,index)=>result.status==='fulfilled'?[{id:ids[index],value:result.value}]:[]);
    // A partial image set is allowed, but failed or expired entries retain no URL.
    const usable=admitted.filter(({value})=>lifecycle.expiresInMs(value)>0);
    for(const entry of admitted)if(!usable.includes(entry))lifecycle.dispose(entry.value);
    if(!usable.length)throw new SurfaceCacheEvictionError(new Error('office_resources_unavailable'));
    return {urls:Object.fromEntries(usable.map(({id,value})=>[id,value.url])),
      projectionDeadline:Math.min(...usable.map(({value})=>value.projectionDeadline)),
      projectionMonotonicDeadline:Math.min(...usable.map(({value})=>value.projectionMonotonicDeadline))};
  },{
    dispose:value=>{for(const url of Object.values(value.urls))URL.revokeObjectURL(url);},
    expiresInMs:value=>Math.min(value.projectionDeadline-Date.now(),value.projectionMonotonicDeadline-performance.now()),
  });
  const projection=useProtectedProjection(key??'office-media:disabled',cache.data,()=>{},cache.refresh);
  return {urls:projection?.urls??{},error:cache.error};
}

export function useOfficeResourceMedia(artifactId:string|null,resourceId:string|null) {
  const result=useOfficeResourceUrls(artifactId,resourceId?[resourceId]:[]);
  return {url:resourceId?result.urls[resourceId]??null:null,error:result.error};
}
