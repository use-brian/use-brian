import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { compileOfficeTemplate, inferOfficeTemplateRouting } from '@use-brian/core'
import { spreadsheetFixture } from '../../../../office-model/src/__tests__/fixtures.js'
import { templateBundle } from '../../../../core/src/office/__tests__/fixtures.js'
import { exportOfficeSpreadsheet, importOfficeSpreadsheet } from '../../../../core/src/office/xlsx/index.js'
import { generateSpreadsheetFromTemplate } from '../spreadsheet-generation.js'
import { recalculateSpreadsheet, type SpreadsheetCell } from '@use-brian/office-model'

function fixture() {
  const snapshot=spreadsheetFixture(), sheet=snapshot.worksheets[0]!
  const cell=(address:string,value:SpreadsheetCell['value'],formula?:string):SpreadsheetCell=>({id:randomUUID(),address,value,valueType:typeof value==='number'?'number':'string',...(formula?{formula,value:null,valueType:'number'}:{}),style:{},locked:false})
  sheet.cells=[cell('A1','Example Studio'),cell('A3','{{CUSTOMER}}'),cell('A4','{{ADDRESS}}'),cell('A5','{{INVOICE_DATE}}'),cell('B7','{{SERVICE}}'),cell('C7','{{SERVICE_QTY}}'),cell('D7','{{SERVICE_PRICE}}'),cell('E7',null,'IFERROR(C7*D7,"")'),cell('B8','{{HARDWARE}}'),cell('C8','{{HARDWARE_QTY}}'),cell('D8','{{HARDWARE_PRICE}}'),cell('E8',null,'IFERROR(C8*D8,"")'),cell('E10',null,'SUM(E7:E8)'),cell('A12',null,'IF(Setup!A1="","",Setup!A1)'),cell('A13',null,'IF(Setup!A2="","",Setup!A2)')]
  sheet.print.printArea='A1:E15'
  snapshot.worksheets.push({...structuredClone(sheet),id:randomUUID(),name:'Setup',visibility:'veryHidden',cells:[cell('A1','{{PAYMENT_TERMS}}'),cell('A2','{{OPTIONAL_NOTE}}')],print:{...sheet.print,printArea:undefined}})
  const fields=inferOfficeTemplateRouting(snapshot).fields
  for(const field of fields){field.required=field.name!=='OPTIONAL_NOTE';field.type=/(?:QTY|PRICE)$/.test(field.name)?'number':field.name==='INVOICE_DATE'?'date':'plainText'}
  const template={...templateBundle(),family:'spreadsheet' as const,name:'Invoice',snapshot:recalculateSpreadsheet(snapshot).snapshot,fields,slideRecipes:[],requiredEvidence:[]}
  const values:Record<string,{valueType:string;value:string|number|null}>={CUSTOMER:{valueType:'string',value:'Example Customer Limited'},ADDRESS:{valueType:'string',value:'12 Example Road'},INVOICE_DATE:{valueType:'date',value:'2026-01-15T00:00:00.000Z'},SERVICE:{valueType:'string',value:'Monthly service'},SERVICE_QTY:{valueType:'number',value:1},SERVICE_PRICE:{valueType:'number',value:1200},HARDWARE:{valueType:'string',value:'Hardware'},HARDWARE_QTY:{valueType:'number',value:2},HARDWARE_PRICE:{valueType:'number',value:150},PAYMENT_TERMS:{valueType:'string',value:'Net 30, confirmed'},OPTIONAL_NOTE:{valueType:'blank',value:null}}
  const provider={async *stream(){yield{type:'text_delta',text:JSON.stringify({title:'Invoice',values})}}}
  return {template,values,provider,snapshot}
}

describe('[COMP:api/office-generation] mapped invoice template',()=>{
  it('admits, fills and reopens an invoice with exact mappings, formulas, branding and blank-safe optional text',async()=>{
    const f=fixture()
    const compiled=await compileOfficeTemplate({authoringPath:'upload',draft:f.template,resources:[]})
    expect(compiled.receipt.diagnostics).toEqual([])
    expect(compiled.bundle?.status).toBe('admitted')
    const result=await generateSpreadsheetFromTemplate({template:compiled.bundle!,provider:f.provider as never,model:'test',artifactId:f.snapshot.artifactId,workspaceId:f.snapshot.workspaceId,templateVersionId:f.template.id,outcome:'Populate the confirmed invoice',audience:'Customer'})
    const cells=result.worksheets[0]!.cells
    expect(cells.find(c=>c.address==='A1')?.value).toBe('Example Studio')
    expect(cells.find(c=>c.address==='A3')?.value).toBe('Example Customer Limited')
    expect(cells.find(c=>c.address==='E10')).toMatchObject({formula:'SUM(E7:E8)',calculatedValue:1500})
    expect(cells.find(c=>c.address==='A13')?.calculatedValue).toBe('')
    const exported=await exportOfficeSpreadsheet(result)
    const reopened=await importOfficeSpreadsheet(exported.bytes,{artifactId:result.artifactId,workspaceId:result.workspaceId,templateVersionId:f.template.id,locale:'en-US',defaultLanguage:'en-US',title:'Invoice'})
    expect(reopened.ok).toBe(true)
    expect(reopened.snapshot?.family==='spreadsheet' && reopened.snapshot.worksheets[1]?.visibility).toBe('veryHidden')
  })
  it('keeps missing payment terms as required input rather than inventing due-on-receipt',async()=>{
    const f=fixture();f.values.PAYMENT_TERMS={valueType:'blank',value:null}
    await expect(generateSpreadsheetFromTemplate({template:f.template,provider:f.provider as never,model:'test',artifactId:f.snapshot.artifactId,workspaceId:f.snapshot.workspaceId,templateVersionId:f.template.id,outcome:'Populate invoice',audience:'Customer'})).rejects.toMatchObject({fields:['PAYMENT_TERMS']})
    expect(JSON.stringify(f.template)).not.toContain('Due on receipt')
  })
})
