import { isStrongWorkspaceSearchMatch, type WorkspaceSearchItem } from '@use-brian/shared'

export type SearchSelection = { key: string | null; deliberate: boolean }
/** Failed/incomplete retrieval never chooses Ask on the user's behalf. */
export function selectWorkspaceSearchAction(input: {
  items: readonly WorkspaceSearchItem[]; state: 'loading' | 'error' | 'partial' | 'complete';
  previous?: SearchSelection; askAvailable: boolean;
}): SearchSelection {
  if (input.state === 'loading') return {key:null,deliberate:false}
  const valid=(key:string|null)=> key === 'ask' ? input.askAvailable : input.items.some(item=>item.key===key)
  if (input.previous?.deliberate && valid(input.previous.key)) return input.previous
  const strong=input.items.find(item=>isStrongWorkspaceSearchMatch(item.match))
  return {key:strong?.key ?? (input.state==='complete' && input.askAvailable ? 'ask' : null),deliberate:false}
}
