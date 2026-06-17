// Generate the minimal sample.xlsx fixture used by parsers.test.ts.
// Two sheets exercising the cases xlsx.ts must handle: a currency number, a
// date, a formula (we extract its computed result), and a pipe that must be
// escaped in the Markdown table.
//
// Run from this dir:  node make-sample-xlsx.mjs
import ExcelJS from 'exceljs'

const wb = new ExcelJS.Workbook()

const financials = wb.addWorksheet('Financials')
financials.addRow(['Metric', 'Value'])
financials.addRow(['Revenue', 40000]).getCell(2).numFmt = '$#,##0'
financials.addRow(['Close date', new Date(Date.UTC(2026, 0, 15))]).getCell(2).numFmt = 'yyyy-mm-dd'
financials.addRow(['Doubled', { formula: 'B2*2', result: 80000 }])

const notes = wb.addWorksheet('Notes')
notes.addRow(['Comment'])
notes.addRow(['Pipe | inside'])

await wb.xlsx.writeFile(new URL('./sample.xlsx', import.meta.url).pathname)
console.log('wrote sample.xlsx')
