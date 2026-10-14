import {describe,it,expect} from 'vitest'
import {buildWorkspaceFilesContext} from '../context-builder.js'
import type {WorkspaceFileIndexRow} from '../types.js'
describe('[COMP:core/engineering-archive-isolation] ambient context',()=>{
 it('excludes archive paths, names and summaries even if a legacy adapter supplied them',()=>{
  const base={id:'fixture',workspaceId:'workspace',title:null,summary:null,mime:'text/plain',sizeBytes:1,tags:[],sensitivity:'internal' as const,compartments:[],projectIds:[],updatedAt:new Date()}
  const rows:WorkspaceFileIndexRow[]=[{...base,purpose:'engineering_archive',path:'/archive-secret',name:'private-secret',summary:'secret-summary',parentPath:'/'},
   {...base,purpose:'operational',path:'/ordinary.txt',name:'Ordinary',parentPath:'/',mime:'text/plain'}]
  const context=buildWorkspaceFilesContext(rows)
  expect(context).toContain('/ordinary.txt');expect(context).not.toContain('secret')
 })
})
