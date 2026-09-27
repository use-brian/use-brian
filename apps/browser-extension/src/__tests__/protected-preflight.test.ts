import { describe, it, expect, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { TabExecutor } from '../executor.js'

async function fixture() {
  const document = {}
  class Input {
    ownerDocument = document; isConnected = true; disabled = false; readOnly = false; type = 'text'; stored = ''
    closest() {return null} getClientRects() {return [1]} dispatchEvent() {}
    set value(v: string) {this.stored=v}
  }
  class Textarea extends Input { set value(v: string) {this.stored=v} }
  const nodes = [new Input(),new Textarea()]
  const window = {}
  const context:any = {document,window,top:window,location:{origin:'https://dest.example'},HTMLInputElement:Input,HTMLTextAreaElement:Textarea,getComputedStyle:()=>({visibility:'visible'}),Event:class {}}
  const objects:any = {n1:nodes[0],n2:nodes[1]}
  const sendCommand=vi.fn(async (_:any,method:string,p:any) => {
    if(method==='Page.getFrameTree') return {frameTree:{frame:{id:'top'}}}
    if(method==='Page.createIsolatedWorld') {expect(p.frameId).toBe('top');return {executionContextId:7}}
    if(method==='DOM.resolveNode') {expect(p.executionContextId).toBe(7);return {object:{objectId:`n${p.backendNodeId}`}}}
    if(method==='Runtime.callFunctionOn') {
      try {
        const fn=runInNewContext(`(${p.functionDeclaration})`,context)
        const value=fn.apply(p.objectId?objects[p.objectId]:undefined,(p.arguments??[]).map((a:any)=>a.objectId?objects[a.objectId]:a.value))
        if(typeof value==='object') {objects.prepared=value;return {result:{objectId:'prepared'}}}
        return {result:{value}}
      } catch {return {result:{},exceptionDetails:{text:'never propagate'}}}
    }
    return {}
  })
  vi.stubGlobal('chrome',{debugger:{attach:vi.fn(async()=>{}),detach:vi.fn(async()=>{}),sendCommand}})
  const executor=new TabExecutor()
  await executor.attach(1)
  ;(executor as any).lastSnapshot={refToBackendNodeId:new Map([['@e1',1],['@e2',2]])}
  return {executor,nodes,context,sendCommand}
}
describe('isolated protected DOM preflight and assignment',()=>{
  it('fills multiple text targets without snapshot/readback',async()=>{
    const {executor,nodes,sendCommand}=await fixture()
    const assign=await executor.prepareProtectedFill('https://dest.example',['@e1','@e2'])
    await assign([{ref:'@e1',value:'sentinel-1'},{ref:'@e2',value:'sentinel-2'}])
    expect(nodes.map(n=>n.stored)).toEqual(['sentinel-1','sentinel-2'])
    expect(sendCommand.mock.calls.some(c=>/Snapshot|Accessibility|getOuterHTML|capture/i.test(c[1]) && c[1]!=='Accessibility.enable')).toBe(false)
  })
  it('rejects forbidden input types, iframe nodes, disabled and detached fields before resolve',async()=>{
    for(const change of [
      (n:any)=>{n.type='password'},(n:any)=>{n.type='file'},(n:any)=>{n.type='hidden'},(n:any)=>{n.type='submit'},
      (n:any)=>{n.ownerDocument={}},(n:any)=>{n.disabled=true},(n:any)=>{n.isConnected=false},(n:any)=>{n.readOnly=true},
    ]) {
      const {executor,nodes}=await fixture();change(nodes[0])
      await expect(executor.prepareProtectedFill('https://dest.example',['@e1','@e2'])).rejects.toThrow()
    }
  })
  it('denies changed origin/document and revalidates before every assignment',async()=>{
    for(const mode of ['origin','document','target']) {
      const {executor,nodes,context}=await fixture()
      const assign=await executor.prepareProtectedFill('https://dest.example',['@e1','@e2'])
      nodes[0].dispatchEvent=()=>{
        if(mode==='origin') context.location.origin='https://other.example'
        if(mode==='document') context.document={}
        if(mode==='target') nodes[1].disabled=true
      }
      await expect(assign([{ref:'@e1',value:'first'},{ref:'@e2',value:'second'}])).rejects.toThrow()
      expect(nodes[1].stored).toBe('')
    }
  })
  it('keeps global dispatch lock ahead of all non-stop operations and Firefox native fallback',()=>{
    const chromium=readFileSync(new URL('../background.ts',import.meta.url),'utf8')
    const execute=chromium.slice(chromium.indexOf('async function executeOp('),chromium.indexOf('async function attachToEligibleTab('))
    expect(execute.indexOf('if (op === \'stop\')')).toBeLessThan(execute.indexOf('protectedFill.locked()'))
    expect(execute.indexOf('protectedFill.locked()')).toBeLessThan(execute.indexOf('return await dispatch'))
    expect(chromium).toContain('commandQueue.then(() => handleCommand(cmd))')
    const firefox=readFileSync(new URL('../firefox-background.ts',import.meta.url),'utf8')
    const ff=firefox.slice(firefox.indexOf('async function executeOp('))
    expect(ff.indexOf("op === 'browserFillReference'")).toBeLessThan(ff.indexOf('native.status()'))
  })
})
