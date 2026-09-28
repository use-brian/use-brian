// @vitest-environment jsdom
import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {ConfirmDialogProvider,confirmDialog} from '../confirm-dialog'
;(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
let root:Root,host:HTMLDivElement
beforeEach(async()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<ConfirmDialogProvider/>))})
afterEach(async()=>{await act(async()=>root.unmount());host.remove()})
describe('[COMP:app-web/confirm-dialog] permission-bound cancellation',()=>{
  it('cancels an active review, removes its content, and preserves the next queued confirmation',async()=>{
    const controller=new AbortController();let first:Promise<boolean>,second:Promise<boolean>
    await act(async()=>{first=confirmDialog({signal:controller.signal,title:'First review',description:'Private configuration'});second=confirmDialog({title:'Second review',description:'Next configuration',confirmLabel:'Apply next',cancelLabel:'Cancel next'})})
    expect(document.body.textContent).toContain('Private configuration')
    await act(async()=>controller.abort())
    expect(await first!).toBe(false)
    expect(document.body.textContent).not.toContain('Private configuration')
    expect(document.body.textContent).toContain('Next configuration')
    const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Apply next')!
    await act(async()=>button.click());expect(await second!).toBe(true)
  })
  it('does not display an aborted queued review or a signal that was already aborted',async()=>{
    const controller=new AbortController();let first:Promise<boolean>,queued:Promise<boolean>
    await act(async()=>{first=confirmDialog({title:'Active',description:'First',confirmLabel:'Apply first'});queued=confirmDialog({signal:controller.signal,title:'Queued',description:'Never display'})})
    await act(async()=>controller.abort());expect(await queued!).toBe(false)
    expect(await confirmDialog({signal:controller.signal,description:'Already cancelled'})).toBe(false)
    await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(row=>row.textContent==='Apply first')!.click())
    expect(await first!).toBe(true);expect(document.body.textContent).not.toContain('Never display')
  })
})
