/**
 * A fictional light invoice workbook built as real XLSX bytes, shaped for the
 * invoice PDF preset: an Invoice sheet (A1:H48, A4 portrait, one page, logo)
 * and a very hidden Setup sheet. Every name and value is invented.
 */
import ExcelJS from 'exceljs'

export const CRM_INVOICE_FIXTURE_LINES = 5

/** 96x40 fictional logo: a solid PNG generated here, not copied from anywhere. */
export async function fictionalLogoPng(): Promise<Uint8Array> {
  const { default: sharp } = await import('sharp')
  return new Uint8Array(await sharp({ create: { width: 96, height: 40, channels: 3, background: { r: 32, g: 96, b: 160 } } }).png().toBuffer())
}

export async function buildFictionalInvoiceXlsx(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Invoice')
  const put = (address: string, value: ExcelJS.CellValue, numFmt?: string) => {
    const cell = sheet.getCell(address)
    cell.value = value
    if (numFmt) cell.numFmt = numFmt
  }
  sheet.getColumn(1).width = 14
  for (const column of [2, 3, 4, 5]) sheet.getColumn(column).width = 12
  sheet.getColumn(6).width = 8
  sheet.getColumn(7).width = 14
  sheet.getColumn(8).width = 14
  const logo = workbook.addImage({ buffer: Buffer.from(await fictionalLogoPng()) as never, extension: 'png' })
  sheet.addImage(logo, { tl: { col: 0, row: 0 }, ext: { width: 96, height: 40 }, editAs: 'oneCell' } as never)
  put('E2', '{{SELLER_NAME}}')
  put('F6', 'Invoice no.'); put('G6', '{{INVOICE_NUMBER}}')
  put('F7', 'Issue date'); put('G7', '{{ISSUE_DATE}}', 'yyyy-mm-dd')
  put('A12', 'Bill to'); put('A14', '{{CUSTOMER}}'); put('A15', '{{BILLING_ADDRESS}}')
  put('E13', 'Engagement'); put('E14', '{{ACCOUNT_LABEL}}')
  put('B20', 'Description'); put('F20', 'Qty'); put('G20', 'Unit price'); put('H20', 'Amount')
  for (let line = 1; line <= CRM_INVOICE_FIXTURE_LINES; line++) {
    const row = 20 + line
    put(`B${row}`, `{{LINE_${line}_DESCRIPTION}}`)
    put(`F${row}`, `{{LINE_${line}_QTY}}`, '#,##0.00')
    put(`G${row}`, `{{LINE_${line}_PRICE}}`, '#,##0.00')
    put(`H${row}`, { formula: `IF(F${row}="","",IFERROR(ROUND(F${row}*G${row},2),""))`, result: '' }, '#,##0.00')
  }
  put('G34', 'Subtotal'); put('H34', { formula: 'SUM(H21:H25)', result: 0 }, '#,##0.00')
  put('G35', 'Tax rate'); put('H35', '{{TAX_RATE}}', '0.00%')
  put('G36', 'Tax'); put('H36', { formula: 'IFERROR(ROUND(H34*H35,2),0)', result: 0 }, '#,##0.00')
  put('G37', 'Total'); put('H37', { formula: 'H34+H36', result: 0 }, '#,##0.00')
  put('G38', 'Paid'); put('H38', 0, '#,##0.00')
  put('G39', 'Balance due'); put('H39', { formula: 'H37-H38', result: 0 }, '#,##0.00')
  put('A34', 'Pay to'); put('A35', '{{PAYMENT_PROVIDER}}')
  put('A38', 'Payment instructions'); put('A39', '{{PAYMENT_INSTRUCTIONS}}')
  put('A41', '{{PAYMENT_TERMS}}')
  put('A44', 'Currency'); put('B44', '{{CURRENCY}}')
  sheet.pageSetup = { printArea: 'A1:H48', paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1,
    margins: { left: 0.35, right: 0.35, top: 0.25, bottom: 0.25, header: 0, footer: 0 } }
  const setup = workbook.addWorksheet('Setup', { state: 'veryHidden' })
  setup.getCell('A1').value = 'Fictional setup notes for the template author'
  return new Uint8Array(await workbook.xlsx.writeBuffer())
}

/** The template field configuration an operator would accept for this workbook. */
export function fictionalInvoiceFieldTypes(name: string): { type: 'plainText' | 'number' | 'date'; required: boolean } {
  const type = /_(QTY|PRICE)$/.test(name) || name === 'TAX_RATE' ? 'number' : name === 'ISSUE_DATE' ? 'date' : 'plainText'
  const required = ['SELLER_NAME', 'INVOICE_NUMBER', 'ISSUE_DATE', 'CUSTOMER', 'ACCOUNT_LABEL', 'LINE_1_DESCRIPTION', 'LINE_1_QTY', 'LINE_1_PRICE',
    'TAX_RATE', 'PAYMENT_PROVIDER', 'PAYMENT_INSTRUCTIONS', 'CURRENCY'].includes(name)
  return { type, required }
}
