/** Explicit opt-in synthetic template; contains no customer identity, policy, or statutory assertions. */
import type { Template } from './render.js'
export function syntheticTemplate(workspaceId:string):Template {
 const id=(n:number)=>`a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`
 const style={fontFamily:'Noto Sans CJK SC',fontSizePt:12,bold:false,italic:false,underline:false,strike:false,color:'#000000'}
 return {id:'synthetic-bilingual',version:1,fields:{name:{runId:id(7),type:'string'},amount:{runId:id(9),type:'string'}},snapshot:{schemaVersion:1,capabilityVersion:1,family:'document',artifactId:id(1),workspaceId,locale:'en-US',defaultLanguage:'zh-CN',templateVersionId:id(2),rootId:id(3),title:'Synthetic statement / 合成报表',resources:[],accessibility:{title:'Synthetic statement / 合成报表'},sections:[{id:id(4),page:{widthPt:595,heightPt:842,marginTopPt:50,marginRightPt:50,marginBottomPt:50,marginLeftPt:50,orientation:'portrait'},header:[],footer:[],showPageNumber:true,nodes:[{id:id(5),kind:'paragraph',styleName:'Body',alignment:'start',runs:[{id:id(6),text:'Name / 姓名: ',style},{id:id(7),text:'Synthetic person',style}]},{id:id(8),kind:'paragraph',styleName:'Body',alignment:'start',runs:[{id:id(10),text:'Amount / 金额: ',style},{id:id(9),text:'0.00',style}]}]}]}}
}
