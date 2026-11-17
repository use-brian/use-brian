// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "lucide-react";
import { ChoiceCards, ResponsiveTable, StatusPill, associationStatusTone } from "../ui";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement,root:Root;
beforeEach(()=>{host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(node:React.ReactNode){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));}
describe("[COMP:app-web/association] Console building blocks",()=>{
  it("maps commerce and membership states onto a shared tone scale",()=>{
    expect(associationStatusTone("paid")).toBe("success");expect(associationStatusTone("pending")).toBe("warning");
    expect(associationStatusTone("needs_reconciliation")).toBe("danger");expect(associationStatusTone("mystery")).toBe("neutral");
  });
  it("labels a status through the dictionary and falls back to the raw value",async()=>{
    await render(<><StatusPill status="on_sale"/><StatusPill status="paid"/><StatusPill status="custom_state"/></>);
    expect(host.textContent).toContain(en.associationPage.manage.options.on_sale);
    expect(host.textContent).toContain(en.associationPage.orderStates.paid);
    expect(host.textContent).toContain("custom_state");
  });
  it("renders one labelled row per record with the primary cell as the row action",async()=>{
    const rows=[{id:"1",name:"First"},{id:"2",name:"Second"}];let opened="";
    await render(<ResponsiveTable rows={rows} rowKey={row=>row.id} onRowClick={row=>{opened=row.id;}} empty={<p>none</p>} rowData={row=>({"data-test-row":row.id})}
      columns={[{key:"name",label:"Name",primary:true,cell:row=>row.name},{key:"id",label:"Id",cell:row=>row.id}]}/>);
    expect(host.querySelectorAll("[data-test-row]")).toHaveLength(2);
    expect(host.querySelectorAll('[role="cell"][data-label="Name"]')).toHaveLength(2);
    await act(async()=>[...host.querySelectorAll("button")].find(button=>button.textContent==="Second")!.click());
    expect(opened).toBe("2");
    await render(<ResponsiveTable rows={[]} rowKey={()=>""} empty={<p>none</p>} columns={[]}/>);
    expect(host.textContent).toBe("none");
  });
  it("uses neutral F04 choice chrome for dots and icons without recoloring semantic status pills",async()=>{
    const options=[{value:"a",label:"A"},{value:"b",label:"B",icon:Calendar}];
    await render(<><ChoiceCards label="Pick" value="a" onChange={()=>{}} options={options}/><StatusPill status="custom" tone="info"/></>);
    const radios=()=>[...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios()[0].className).toContain("border-interaction/60 bg-interaction/5");
    expect(radios()[0].querySelector('[aria-hidden]')?.className).toContain("border-interaction bg-interaction");
    expect(radios()[1].className).toContain("border-border hover:bg-accent/40");
    await render(<><ChoiceCards label="Pick" value="b" onChange={()=>{}} options={options}/><StatusPill status="custom" tone="info"/></>);
    expect(radios()[1].className).toContain("border-interaction/60 bg-interaction/5");
    expect(radios()[1].querySelector("svg")?.getAttribute("class")).toContain("text-foreground");
    expect(host.querySelector('[role="radiogroup"]')?.innerHTML).not.toMatch(/(?:border|bg|text|ring)-primary/);
    expect(host.lastElementChild?.className).toContain("bg-primary/10 text-primary");
  });
  it("preserves disabled choice buttons and the fallback tab stop",async()=>{
    const change=vi.fn();
    await render(<ChoiceCards label="Pick" value="missing" disabled onChange={change} options={[{value:"a",label:"A"},{value:"b",label:"B"}]}/>);
    const radios=[...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map(radio=>radio.tabIndex)).toEqual([0,-1]);
    expect(radios.every(radio=>radio.disabled)).toBe(true);
    await act(async()=>radios.forEach(radio=>radio.click()));
    expect(change).not.toHaveBeenCalled();
  });
  it("moves the choice with arrow keys and reports the checked card",async()=>{
    function Cards(){const [value,setValue]=useState<"a"|"b">("a");return <ChoiceCards label="Pick" value={value} onChange={setValue} options={[{value:"a",label:"A"},{value:"b",label:"B"}]}/>;}
    await render(<Cards/>);
    const first=host.querySelector<HTMLButtonElement>('[role="radio"]')!;
    await act(async()=>{first.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));});
    const radios=[...host.querySelectorAll('[role="radio"]')];
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Pick");
    expect(document.activeElement).toBe(radios[1]);
    expect(radios.map(radio=>(radio as HTMLButtonElement).tabIndex)).toEqual([-1,0]);
    for(const [key,index] of [["ArrowDown",0],["ArrowLeft",1],["ArrowUp",0]] as const){
      await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true})));
      expect(radios[index].getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(radios[index]);
      expect(radios[index].className).toContain("border-interaction/60 bg-interaction/5");
    }
  });
});
