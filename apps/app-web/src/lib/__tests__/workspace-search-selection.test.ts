import { describe, expect, it } from 'vitest'
import { classifyWorkspaceSearchMatch, type WorkspaceSearchItem, type WorkspaceSearchMatch } from '@use-brian/shared'
import { selectWorkspaceSearchAction as select } from '../workspace-search-selection'
import { workspaceSearchHref } from '../workspace-search-navigation'
const item=(key:string,match:WorkspaceSearchMatch):WorkspaceSearchItem=>({key,match,id:key,kind:'tasks',title:key,snippet:'',source:'tasks',target:{type:'brain',id:key,primitive:'tasks'}})
describe('[COMP:app-web/workspace-search-selection] visible action selection and destinations',()=>{
  it.each(['exact','prefix','tokens'] as const)('selects highest strong %s hit',match=>{
    expect(select({items:[item('first',match),item('second',match)],state:'complete',askAvailable:true}).key).toBe('first')
  })
  it('keeps weak suggestions but defaults to Ask only after a complete search',()=>{
    expect(select({items:[item('weak','body')],state:'complete',askAvailable:true}).key).toBe('ask')
    for(const state of ['error','partial','loading'] as const)expect(select({items:[item('weak','partial')],state,askAvailable:true}).key).toBeNull()
  })
  it('preserves deliberate weak or Ask selection through late results but clears pending selection',()=>{
    const previous={key:'weak',deliberate:true}
    expect(select({items:[item('strong','exact'),item('weak','body')],state:'complete',askAvailable:true,previous})).toEqual(previous)
    expect(select({items:[],state:'partial',askAvailable:true,previous:{key:'ask',deliberate:true}}).key).toBe('ask')
    expect(select({items:[item('weak','body')],state:'loading',askAvailable:true,previous}).key).toBeNull()
  })
  it('normalizes fullwidth and CJK with exact, prefix, all-token and body distinctions',()=>{
    expect(classifyWorkspaceSearchMatch('ＡＴＬＡＳ','atlas')).toBe('exact')
    expect(classifyWorkspaceSearchMatch('Atlas plan','atlas')).toBe('prefix')
    expect(classifyWorkspaceSearchMatch('季度產品計劃','產品')).toBe('tokens')
    expect(classifyWorkspaceSearchMatch('Atlas plan','atlas missing')).toBe('partial')
    expect(classifyWorkspaceSearchMatch('Other','atlas')).toBe('body')
  })
  it('opens every canonical family without accepting external navigation',()=>{
    const cases:Array<[WorkspaceSearchItem['target'],string]>=[
      [{type:'page',id:'p'},'/w/ws/p/p'],[{type:'knowledge',id:'k',path:'/x'},'/w/ws/brain/entry/knowledge/k'],
      [{type:'brain',id:'m',primitive:'memories'},'/w/ws/brain?row=m&kind=memory'],[{type:'record',id:'r',entityTypeId:'t'},'/w/ws/records/r?type=t'],
      [{type:'recording',id:'r'},'/w/ws/recordings/r'],[{type:'office',id:'o',family:'document'},'/w/ws/office/o'],
      [{type:'conversation',id:'s',visibility:'workspace'},'/w/ws/chat?v=workspace&s=s'],[{type:'workflow',id:'f'},'/w/ws/workflow/f'],
    ]
    for(const [target,path] of cases)expect(workspaceSearchHref('ws',target)).toBe(path)
  })
})
