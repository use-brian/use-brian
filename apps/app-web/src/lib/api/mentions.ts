import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Resolvers for the inline `@`-mention popup (people + pages tabs).
 *
 *   - `fetchMembers(workspaceId, query)` → workspace members, filtered by
 *     a case-insensitive substring over name/email. Backed by
 *     `GET /api/workspaces/:id/member-directory` and the existing bounded
 *     viewer/workspace surface cache; query filtering is local.
 *   - `fetchPages(workspaceId, query)` → currently visible saved + draft pages,
 *     filtered locally over the page title. Backed by the bounded page directory.
 *
 * Both return the trim shapes the shared `<MentionPopup>` expects
 * (`PersonMentionItem` / `PageMentionItem`). Empty query returns a small
 * recent-ish slice (the first N rows) — the popup's "recents" cue.
 *
 * [COMP:app-web/mention-fetchers]
 */

import { authFetch } from "@/lib/auth-fetch";
import {getUserInfo} from '@/lib/user';
import {loadSurfaceCache,readSurfaceCache,SurfaceCacheEvictionError} from '@/lib/surface-cache';
import {pageDirectoryCacheKey,workspaceMemberDirectoryCacheKey} from '@/lib/surface-prefetch';
import {protectProjection,projectionRemainingMs,type ProtectedProjection} from '@/lib/use-protected-projection';
import type {
  PageMentionItem,
  PersonMentionItem,
} from "@/components/doc/mentions/mention-popup";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** How many rows the popup shows for an empty query (the "recent" cue). */
const EMPTY_QUERY_CAP = 8;

export type WorkspaceMemberDirectory = ProtectedProjection<{
  workspaceId: string;
  viewerId: string;
  validForMs: number;
  members: {
    memberId:string;
    userId:string;
    name:string|null;
    email:string|null;
    avatarUrl:string|null;
    role:'owner'|'admin'|'member';
    canDraft:boolean;
  }[];
}>;
const directorySource=Symbol('member-directory-source');
type DirectoryPerson=PersonMentionItem & {[directorySource]?:WorkspaceMemberDirectory};

export async function readWorkspaceMemberDirectory(workspaceId:string,viewerId:string):Promise<WorkspaceMemberDirectory> {
  const started=performance.now();
  const res=await authFetch(`${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/member-directory`,{cache:'no-store'});
  if(!res.ok){
    const error=new Error('member_directory_unavailable');
    if([401,403,404,409].includes(res.status))throw new SurfaceCacheEvictionError(error);
    throw error;
  }
  const body=await res.json();
  if(!viewerId||getUserInfo()?.id!==viewerId||body.viewerId!==viewerId||body.workspaceId!==workspaceId||!Array.isArray(body.members))throw new SurfaceCacheEvictionError(new Error('member_directory_owner_changed'));
  return protectProjection(body,started);
}

/** Filter a current projection, retaining the originating read on each person. */
export function directoryPeople(data:WorkspaceMemberDirectory|undefined,query?:string):PersonMentionItem[] {
  if(!data||getUserInfo()?.id!==data.viewerId||projectionRemainingMs(data)<=0)return [];
  const q=query?.trim().toLowerCase();
  const all=data.members.map(member=>{
    const item:PersonMentionItem={kind:'person',id:member.userId,name:member.name||member.email||member.userId,email:member.email,avatarUrl:member.avatarUrl};
    Object.defineProperty(item,directorySource,{value:data});return item;
  });
  if(query===undefined)return all;
  return q?all.filter(member=>member.name.toLowerCase().includes(q)||(member.email??'').toLowerCase().includes(q)):all.slice(0,EMPTY_QUERY_CAP);
}

export function isCurrentDirectoryPerson(workspaceId:string,person:PersonMentionItem|string):boolean {
  const viewerId=getUserInfo()?.id;
  if(!viewerId)return false;
  const current=readSurfaceCache<WorkspaceMemberDirectory>(workspaceMemberDirectoryCacheKey(workspaceId,viewerId)).data;
  if(!current||current.workspaceId!==workspaceId||current.viewerId!==viewerId||projectionRemainingMs(current)<=0)return false;
  if(typeof person!=='string'&&(person as DirectoryPerson)[directorySource]!==current)return false;
  return current.members.some(member=>member.userId===(typeof person==='string'?person:person.id));
}

/** Full authorized roster, using the one common cache rather than a promise map. */
export async function listWorkspaceMembers(workspaceId:string):Promise<PersonMentionItem[]> {
  const viewerId=getUserInfo()?.id;
  if(!viewerId)return [];
  const key=workspaceMemberDirectoryCacheKey(workspaceId,viewerId);
  let data=readSurfaceCache<WorkspaceMemberDirectory>(key).data;
  if(!data||projectionRemainingMs(data)<=0)data=await loadSurfaceCache(key,()=>readWorkspaceMemberDirectory(workspaceId,viewerId),{expiresInMs:projectionRemainingMs});
  return directoryPeople(data);
}

export type WorkspacePageDirectory = ProtectedProjection<{
  workspaceId:string;
  viewerId:string;
  validForMs:number;
  pages:{id:string;title:string}[];
}>;
const pageDirectorySource=Symbol('page-directory-source');
type DirectoryPage=PageMentionItem & {[pageDirectorySource]?:WorkspacePageDirectory};

export async function readWorkspacePageDirectory(workspaceId:string,viewerId:string):Promise<WorkspacePageDirectory> {
  const started=performance.now();
  const res=await authFetch(`${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/page-directory`,{cache:'no-store'});
  if(!res.ok){
    const error=new Error('page_directory_unavailable');
    if([401,403,404,409].includes(res.status))throw new SurfaceCacheEvictionError(error);
    throw error;
  }
  const body=await res.json();
  if(!viewerId||getUserInfo()?.id!==viewerId||body.viewerId!==viewerId||body.workspaceId!==workspaceId||!Array.isArray(body.pages))throw new SurfaceCacheEvictionError(new Error('page_directory_owner_changed'));
  return protectProjection(body,started);
}

export function directoryPages(data:WorkspacePageDirectory|undefined,query?:string):PageMentionItem[] {
  if(!data||getUserInfo()?.id!==data.viewerId||projectionRemainingMs(data)<=0)return [];
  const q=query?.trim().toLowerCase();
  const all=data.pages.map(page=>{
    const item:PageMentionItem={kind:'page',id:page.id,title:page.title};
    Object.defineProperty(item,pageDirectorySource,{value:data});return item;
  });
  if(query===undefined)return all;
  return q?all.filter(page=>page.title.toLowerCase().includes(q)):all.slice(0,EMPTY_QUERY_CAP);
}

export function isCurrentDirectoryPage(workspaceId:string,page:PageMentionItem|string):boolean {
  const viewerId=getUserInfo()?.id;
  if(!viewerId)return false;
  const current=readSurfaceCache<WorkspacePageDirectory>(pageDirectoryCacheKey(workspaceId,viewerId)).data;
  if(!current||current.workspaceId!==workspaceId||current.viewerId!==viewerId||projectionRemainingMs(current)<=0)return false;
  if(typeof page!=='string'&&(page as DirectoryPage)[pageDirectorySource]!==current)return false;
  return current.pages.some(item=>item.id===(typeof page==='string'?page:page.id));
}

async function listWorkspacePages(workspaceId:string):Promise<PageMentionItem[]> {
  const viewerId=getUserInfo()?.id;
  if(!viewerId)return [];
  const key=pageDirectoryCacheKey(workspaceId,viewerId);
  let data=readSurfaceCache<WorkspacePageDirectory>(key).data;
  if(!data||projectionRemainingMs(data)<=0)data=await loadSurfaceCache(key,()=>readWorkspacePageDirectory(workspaceId,viewerId),{expiresInMs:projectionRemainingMs});
  return directoryPages(data);
}

/** `@person` resolver; open consumers subscribe to the same bounded projection. */
export async function fetchMembers(workspaceId:string,query:string):Promise<PersonMentionItem[]> {
  const all=await listWorkspaceMembers(workspaceId);
  const q=query.trim().toLowerCase();
  return q?all.filter(member=>member.name.toLowerCase().includes(q)||(member.email??'').toLowerCase().includes(q)):all.slice(0,EMPTY_QUERY_CAP);
}

/** `@page` resolver — current pages, locally substring-filtered by title. */
export async function fetchPages(
  workspaceId: string,
  query: string,
): Promise<PageMentionItem[]> {
  const rows = await listWorkspacePages(workspaceId);
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice(0, EMPTY_QUERY_CAP);
  return rows.filter((p) => p.title.toLowerCase().includes(q));
}
