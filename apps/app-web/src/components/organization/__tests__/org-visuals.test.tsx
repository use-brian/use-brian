// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Building2 } from 'lucide-react';
import { AvatarStack, ClearanceBar, HowItWorks, OrgAvatar, SegmentedTabs, StatStrip, StatTile, departmentTone, tabPanelProps, toneFor } from '../org-visuals';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const render=async(node:React.ReactNode)=>{await act(async()=>root.render(node));};
const labels={public:'Public',internal:'Internal',confidential:'Confidential'};

describe('[COMP:app-web/organization-visuals] shared Organization visuals',()=>{
  it('gives an id one stable palette tone and honours a named department colour',()=>{
    expect(toneFor('unit-1')).toBe(toneFor('unit-1'));
    expect(toneFor('unit-1')).not.toBe('gray');
    expect(departmentTone('Green','team')).toBe('green');
    expect(departmentTone('#123456','team')).toBe(toneFor('team'));
    expect(departmentTone(null,'team')).toBe(toneFor('team'));
  });
  it('renders initials for people and a glyph for assistants, both hidden from assistive tech',async()=>{
    await render(<><OrgAvatar name="riley okafor"/><OrgAvatar name="Ops" kind="assistant"/></>);
    const [person,assistant]=[...host.querySelectorAll('span[aria-hidden]')];
    expect(person.textContent).toBe('R');
    expect(assistant.querySelector('svg')).not.toBeNull();
  });
  it('caps an avatar stack, announces its summary and counts the overflow',async()=>{
    const items=['Ava','Ben','Cy','Di','Ed','Flo','Gus'].map((name,i)=>({id:`p${i}`,name,kind:'member' as const}));
    await render(<AvatarStack items={items} label="7 readers" max={5}/>);
    const stack=host.querySelector('[role="img"]')!;
    expect(stack.getAttribute('aria-label')).toBe('7 readers');
    expect(stack.textContent).toBe('ABCDE+2');
  });
  it('sizes clearance segments by count and summarizes only the levels present',async()=>{
    await render(<ClearanceBar counts={{public:0,internal:3,confidential:1}} labels={labels}/>);
    const bar=host.querySelector('[role="img"]')!;
    expect(bar.getAttribute('aria-label')).toBe('1 Confidential, 3 Internal');
    expect([...bar.children].map(el=>(el as HTMLElement).style.flexGrow)).toEqual(['1','3']);
    expect(host.querySelector('ul')?.textContent).toBe('Confidential 1Internal 3Public 0');
  });
  it('labels stat tiles as a description list',async()=>{
    await render(<StatStrip label="Overview"><StatTile icon={Building2} label="Units" value={6} hint="of 8"/></StatStrip>);
    expect(host.querySelector('dl[aria-label="Overview"] dt')?.textContent).toBe('Units');
    expect(host.querySelector('dd')?.textContent).toBe('6of 8');
  });
  it('keeps longer explanations collapsed behind their summary',async()=>{
    await render(<HowItWorks summary="Reporting lines never grant access."><p>Full policy text.</p></HowItWorks>);
    const details=host.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Reporting lines never grant access.');
    expect(details.textContent).toContain('Full policy text.');
  });
  it('switches panels by click and arrow keys with tab semantics',async()=>{
    function Harness(){
      const [value,setValue]=useState<'a'|'b'|'c'>('a');
      return <><SegmentedTabs value={value} onChange={setValue} label="Panels" idPrefix="x" items={[{value:'a',label:'A',count:2},{value:'b',label:'B'},{value:'c',label:'C'}]}/>
        {(['a','b','c'] as const).map(v=><div key={v} {...tabPanelProps('x',v)} hidden={v!==value}>{v}</div>)}</>;
    }
    await render(<Harness/>);
    const tabs=()=>[...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs().map(tab=>tab.getAttribute('aria-selected'))).toEqual(['true','false','false']);
    expect(tabs()[0].getAttribute('aria-controls')).toBe('x-panel-a');
    expect(host.querySelector('#x-panel-a')?.getAttribute('aria-labelledby')).toBe('x-tab-a');
    await act(async()=>tabs()[2].click());
    expect((host.querySelector('#x-panel-c') as HTMLElement).hidden).toBe(false);
    await act(async()=>host.querySelector('[role="tablist"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs()[0]);
  });
});
