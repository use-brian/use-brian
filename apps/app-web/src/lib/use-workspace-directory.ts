"use client";

/** Current human person choices, shared by mentions and Office assignments.
 * [COMP:app-web/mention-fetchers] */
import {useCallback,useLayoutEffect,useMemo,useRef,useSyncExternalStore} from 'react';
import {getUserInfo,subscribeUserInfo} from './user';
import {invalidateSurfaceCache,useCachedResource} from './surface-cache';
import {pageDirectoryCacheKey,workspaceMemberDirectoryCacheKey} from './surface-prefetch';
import {projectionRemainingMs,useProtectedProjection} from './use-protected-projection';
import {directoryPages,directoryPeople,readWorkspaceMemberDirectory,readWorkspacePageDirectory} from './api/mentions';

const viewer=()=>getUserInfo()?.id??'';
const emptyViewer=()=>'';

export function useWorkspaceDirectory(workspaceId:string|null,query?:string) {
  const subscribe=useCallback((listener:()=>void)=>workspaceId?subscribeUserInfo(listener):()=>{},[workspaceId]);
  const viewerId=useSyncExternalStore(subscribe,viewer,emptyViewer);
  const key=workspaceId&&viewerId?workspaceMemberDirectoryCacheKey(workspaceId,viewerId):null;
  const previous=useRef(key);
  useLayoutEffect(()=>{
    if(previous.current&&previous.current!==key)invalidateSurfaceCache(previous.current);
    previous.current=key;
  },[key]);
  const read=useCachedResource(key,()=>readWorkspaceMemberDirectory(workspaceId!,viewerId),{expiresInMs:projectionRemainingMs});
  const data=read.data?.viewerId===viewerId&&read.data.workspaceId===workspaceId?read.data:undefined;
  const onPurge=useCallback(()=>{},[]);
  const current=useProtectedProjection(key,data,onPurge,read.refresh);
  return useMemo(()=>directoryPeople(current,query),[current,query]);
}

/** Current page-reference choices with the same expiry/identity lifecycle. */
export function useWorkspacePageDirectory(workspaceId:string|null,query?:string) {
  const subscribe=useCallback((listener:()=>void)=>workspaceId?subscribeUserInfo(listener):()=>{},[workspaceId]);
  const viewerId=useSyncExternalStore(subscribe,viewer,emptyViewer);
  const key=workspaceId&&viewerId?pageDirectoryCacheKey(workspaceId,viewerId):null;
  const previous=useRef(key);
  useLayoutEffect(()=>{
    if(previous.current&&previous.current!==key)invalidateSurfaceCache(previous.current);
    previous.current=key;
  },[key]);
  const read=useCachedResource(key,()=>readWorkspacePageDirectory(workspaceId!,viewerId),{expiresInMs:projectionRemainingMs});
  const data=read.data?.viewerId===viewerId&&read.data.workspaceId===workspaceId?read.data:undefined;
  const onPurge=useCallback(()=>{},[]);
  const current=useProtectedProjection(key,data,onPurge,read.refresh);
  return useMemo(()=>directoryPages(current,query),[current,query]);
}
