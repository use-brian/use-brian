// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {PromptDialogProvider,promptDialog} from '../prompt-dialog';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
beforeEach(async()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(<PromptDialogProvider/>));});
afterEach(()=>{act(()=>root.unmount());host.remove();});
const button=(label:string)=>[...document.querySelectorAll('button')].find(x=>x.textContent===label)!;
describe('[COMP:app-web/prompt-dialog] protected prompt cancellation',()=>{
  it('clears active private text and advances the next prompt without returning the private value',async()=>{
    const owner=new AbortController();let first!:Promise<string|null>,second!:Promise<string|null>;
    await act(async()=>{first=promptDialog({title:'First',defaultValue:'Protected name',signal:owner.signal});second=promptDialog({title:'Next',defaultValue:'Next name',confirmLabel:'Save next'});});
    expect(document.querySelector('input')!.value).toBe('Protected name');await act(async()=>owner.abort());expect(await first).toBeNull();
    expect(document.querySelector('input')!.value).toBe('Next name');expect(document.body.innerHTML).not.toContain('Protected name');
    await act(async()=>button('Save next').click());expect(await second).toBe('Next name');
  });
  it('removes queued and already cancelled prompts without disturbing the active prompt',async()=>{
    const owner=new AbortController();let active!:Promise<string|null>,queued!:Promise<string|null>;
    await act(async()=>{active=promptDialog({title:'Current',defaultValue:'Current name',confirmLabel:'Save current'});queued=promptDialog({title:'Queued',defaultValue:'Never show',signal:owner.signal});});
    await act(async()=>owner.abort());expect(await queued).toBeNull();expect(await promptDialog({defaultValue:'Already cancelled',signal:owner.signal})).toBeNull();
    expect(document.querySelector('input')!.value).toBe('Current name');await act(async()=>button('Save current').click());expect(await active).toBe('Current name');expect(document.body.innerHTML).not.toContain('Never show');
  });
  it('settles only once and removes the abort listener after a normal answer',async()=>{
    const owner=new AbortController();let result!:Promise<string|null>;
    await act(async()=>{result=promptDialog({defaultValue:'  Accepted name  ',confirmLabel:'Save',signal:owner.signal});});await act(async()=>button('Save').click());expect(await result).toBe('Accepted name');
    await act(async()=>owner.abort());expect(await result).toBe('Accepted name');
  });
});
