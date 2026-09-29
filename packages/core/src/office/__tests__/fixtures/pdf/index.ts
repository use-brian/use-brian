import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from '@cantoo/pdf-lib'
import sharp from 'sharp'

export async function createSupportedPdfFixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  document.setTitle('Fictional PDF fixture')
  const font = await document.embedFont(StandardFonts.Helvetica)
  const first = document.addPage([612, 792])
  const second = document.addPage([612, 792])
  second.setCropBox(20, 10, 500, 700)
  second.setRotation(degrees(90))

  first.drawText('VECTOR PAGE ONE', { x: 40, y: 750, size: 14, font })
  first.drawRectangle({ x: 36, y: 730, width: 180, height: 2, color: rgb(0.1, 0.3, 0.8) })
  second.drawText('VECTOR PAGE TWO', { x: 40, y: 670, size: 14, font })
  second.drawLine({ start: { x: 40, y: 650 }, end: { x: 240, y: 650 }, thickness: 2, color: rgb(0.7, 0.2, 0.2) })

  const form = document.getForm()
  const text = form.createTextField('fictional.contact_name')
  text.setText('Initial Latin')
  text.addToPage(first, { x: 40, y: 680, width: 180, height: 24, font })
  text.addToPage(second, { x: 40, y: 600, width: 180, height: 24, font })

  const checkbox = form.createCheckBox('fictional.accept_terms')
  checkbox.addToPage(first, { x: 40, y: 630, width: 18, height: 18 })
  checkbox.check()

  const radio = form.createRadioGroup('fictional.plan')
  radio.addOptionToPage('basic', first, { x: 40, y: 580, width: 18, height: 18 })
  radio.addOptionToPage('pro', first, { x: 80, y: 580, width: 18, height: 18 })
  radio.select('pro')

  const dropdown = form.createDropdown('fictional.region')
  dropdown.setOptions(['north', 'south'])
  dropdown.select('north')
  dropdown.addToPage(first, { x: 40, y: 520, width: 140, height: 24, font })

  const list = form.createOptionList('fictional.features')
  list.setOptions(['one', 'two', 'three'])
  list.enableMultiselect()
  list.select(['one', 'three'])
  list.addToPage(first, { x: 40, y: 420, width: 140, height: 70, font })

  const signature = document.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Widget'),
    FT: PDFName.of('Sig'),
    T: PDFString.of('fictional.signature'),
    Rect: [260, 80, 440, 140],
    P: first.ref,
    F: 4,
  })
  const signatureRef = document.context.register(signature)
  first.node.addAnnot(signatureRef)
  document.catalog.getOrCreateAcroForm().addField(signatureRef)

  return document.save({ useObjectStreams: false })
}

export async function createFlatPdfFixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  document.addPage([420, 594]).drawText('FICTIONAL FLAT PDF', { x: 36, y: 540, size: 14, font })
  document.addPage([594, 420]).drawText('SECOND VECTOR PAGE', { x: 36, y: 370, size: 14, font })
  return document.save({ useObjectStreams: false })
}

export async function createTooManyPagesPdfFixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create()
  for (let index = 0; index < 101; index += 1) document.addPage([144, 144])
  return document.save({ useObjectStreams: false })
}

export function withPdfCatalogMarker(bytes: Uint8Array, marker: string): Uint8Array {
  const source = Buffer.from(bytes).toString('latin1')
  const insertion = source.lastIndexOf('%%EOF')
  if (insertion < 0) return bytes
  return Buffer.from(`${source.slice(0, insertion)}\n${marker}\n${source.slice(insertion)}`, 'latin1')
}

export function malformedPdfFixture(): Uint8Array {
  return Buffer.from('%PDF-1.7\nthis is not a valid object graph\n%%EOF', 'ascii')
}

export async function createFictionalSignaturePng(): Promise<Uint8Array> {
  return sharp({ create: { width: 32, height: 12, channels: 4, background: { r: 28, g: 82, b: 160, alpha: 1 } } })
    .png()
    .toBuffer()
}
