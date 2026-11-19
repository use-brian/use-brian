import {randomUUID} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {projectPrivateChatRows} from '../chat-presentation.js'
type Row=Parameters<typeof projectPrivateChatRows>[0][number]
function row(sequence:number,role:Row['role'],content:unknown):Row{return{id:randomUUID(),sequence,role,content,timestamp:'2026-01-01T00:00:00Z',senderUserId:null,senderAssistantId:null,publishedSenderName:null,replyToText:null,attachments:[]}}
const call=(id:string,name='presentDocument',input:unknown={title:'Report',content:'Delivered document',format:'markdown'})=>({type:'tool_use',id,name,input,providerSignature:'PRIVATE_SIGNATURE'})
const result=(id:string,failed=false,content='PRIVATE_TOOL_RESULT')=>({type:'tool_result',toolUseId:id,isError:failed,content})
describe('[COMP:api/session-display-history] private chat presentation projection',()=>{
 it('keeps final text, attachment identity and matched uploaded previews, without embedded bodies or reasoning',()=>{
  const input=row(1,'user',[{type:'text',text:'Read <attached_file id="upload" name="scan.pdf" type="application/pdf">PRIVATE_FILE'},
   {type:'text',text:'_BODY</attached_file> please.'},{type:'image',name:'scan.pdf',mimeType:'application/pdf',data:'YWJj'},
   {type:'thinking',thinking:'PRIVATE_REASONING'},{type:'image',mimeType:'image/png',data:'c2VjcmV0'}])
  const output=projectPrivateChatRows([input])[0]
  expect(output.id).toBe(input.id)
  expect(output.content).toEqual([{type:'text',text:'Read <attached_file id="upload" name="scan.pdf" type="application/pdf"></attached_file>'},
   {type:'text',text:' please.'},{type:'image',name:'scan.pdf',mimeType:'application/pdf',data:'YWJj'}])
  expect(JSON.stringify(output)).not.toContain('PRIVATE_')
 })
 it('closes unfinished attachment headers and strips bodies from quotes',()=>{
  const input=row(1,'user',[{type:'text',text:'<attached_file id="upload" name="draft.txt" type="text/plain" PRIVATE_BODY'}])
  input.replyToText='Quoted <attached_file name="draft.txt">PRIVATE_QUOTE</attached_file> text'
  const output=projectPrivateChatRows([input])[0]
  expect(output.content).toEqual([{type:'text',text:'<attached_file id="upload" name="draft.txt" type="text/plain"></attached_file>'}])
  expect(output.replyToText).toBe('Quoted  text')
  expect(JSON.stringify(output)).not.toContain('PRIVATE_')
 })
 it('keeps confirmed calls in original order and only restores successfully delivered documents',()=>{
  const rows=[row(1,'assistant',[{type:'text',text:'Before'},call('ok'),{type:'text',text:'After'},call('failed'),call('pending')]),
   row(2,'user',[result('ok'),result('failed',true)]),row(3,'assistant',[{type:'text',text:'Final answer'}])]
  const output=projectPrivateChatRows(rows)
  expect(output[0].content.map(b=>b.type)).toEqual(['tool_use','tool_use'])
  expect(output[0].content[0].input).toMatchObject({content:'Delivered document'})
  expect(output[0].content[1].input).toEqual({})
  expect(JSON.stringify(output)).not.toContain('pending')
  expect(JSON.stringify(output)).not.toContain('PRIVATE_')
  expect(output[1].content[1]).toMatchObject({isError:true,content:''})
 })
 it.each(['gap','prompt','assistant_result'])('does not confirm an old document across %s',kind=>{
  const first=row(1,'assistant',[call('same')])
  const rows=kind==='gap'?[first,row(3,'user',[result('same')])]:kind==='prompt'?
   [first,row(2,'user',[{type:'text',text:'New turn'}]),row(3,'user',[result('same')])]:[first,row(2,'assistant',[result('same')])]
  expect(JSON.stringify(projectPrivateChatRows(rows))).not.toContain('Delivered document')
  expect(projectPrivateChatRows(rows)[0].content).toEqual([])
 })
 it('does not expose intermediate legacy tool narration as a delivered answer',()=>{
  const legacy=row(1,'assistant',[{type:'text',text:'Hidden planning'}, {type:'tool_use',name:'fictionalTool',input:{}}])
  const pending=row(2,'assistant',[{type:'text',text:'Unfinished tool narration'},call('pending')])
  expect(projectPrivateChatRows([legacy,pending]).map(row=>row.content)).toEqual([[],[]])
 })
 it('keeps a delivered question with its displayable payload (M5Q-13)',()=>{
  const input={question:'Which colour should the check use?',options:['Blue','Green'],allowCustom:false,context:'Fictional context',actionId:'connector_authorization:fictional',version:2}
  const asked=row(1,'assistant',[{type:'text',text:'Which colour should the check use?'},call('ask','askQuestion',input)])
  const output=projectPrivateChatRows([asked,row(2,'user',[result('ask',false,'[Question for user]: Which colour should the check use?')])])
  expect(output[0].content).toEqual([{type:'text',text:'Which colour should the check use?'},
   {type:'tool_use',id:`${asked.id}:ask`,name:'askQuestion',input:{question:'Which colour should the check use?',options:['Blue','Green'],allowCustom:false,context:'Fictional context'}}])
  expect(JSON.stringify(output)).not.toContain('connector_authorization')
  expect(JSON.stringify(output)).not.toContain('PRIVATE_')
 })
 it('shows the question when the model text omitted it, and drops invalid options',()=>{
  const asked=row(1,'assistant',[{type:'text',text:'One thing first.'},call('ask','askQuestion',{question:'Which region?',options:['EU','EU']})])
  const output=projectPrivateChatRows([asked,row(2,'user',[result('ask')])])
  expect(output[0].content.map(b=>b.type==='text'?b.text:b.input)).toEqual(['One thing first.','Which region?',{question:'Which region?'}])
 })
 it('keeps hiding narration around a failed, unpaired or mixed question call',()=>{
  const failed=[row(1,'assistant',[{type:'text',text:'Hidden failed'},call('a','askQuestion',{question:'Q?'})]),row(2,'user',[result('a',true)])]
  const unpaired=[row(1,'assistant',[{type:'text',text:'Hidden unpaired'},call('a','askQuestion',{question:'Q?'})])]
  const mixed=[row(1,'assistant',[{type:'text',text:'Hidden mixed'},call('a','askQuestion',{question:'Q?'}),call('b','fictionalTool',{})]),row(2,'user',[result('a'),result('b')])]
  for(const rows of [failed,unpaired,mixed]){
   const output=JSON.stringify(projectPrivateChatRows(rows))
   expect(output).not.toContain('Hidden')
   expect(output).not.toContain('"question"')
  }
 })
 it('keeps Page links only for matched successful page-writing calls',()=>{
  const id=randomUUID(),content=JSON.stringify({pageId:id,private:'PRIVATE_PAGE_BODY'})
  const rows=[row(1,'assistant',[call('page','renderPage',{}),call('wrong','readSomething',{}),call('failed','renderPage',{})]),
   row(2,'user',[result('page',false,content),result('wrong',false,content),result('failed',true,content)])]
  expect(projectPrivateChatRows(rows)[1].content.map(b=>b.content)).toEqual([JSON.stringify({pageIds:[id]}),'',''])
 })
 it('restores host activity without attributing a human statement or exposing host read data',()=>{
  const input=row(1,'user',[{type:'host_observation',version:1,id:'host',name:'readSomething',input:{secret:'PRIVATE_INPUT'},content:'PRIVATE_OUTPUT',isError:false}])
  input.senderUserId=randomUUID();input.publishedSenderName='Fictional human'
  const output=projectPrivateChatRows([input])[0]
  expect(output).toMatchObject({role:'assistant',senderUserId:null,publishedSenderName:null})
  expect(output.content.map(b=>b.type)).toEqual(['tool_use','tool_result'])
  expect(JSON.stringify(output)).not.toContain('PRIVATE_')
 })
})
