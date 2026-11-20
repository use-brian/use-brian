/** Protected server-side page raster for exact PDF approval previews.
 * [COMP:office/pdf-tools] */
import { lazyImplementation } from '@use-brian/agent-runtime/tools/lazy-implementation.js'

// The PDF rasterizer loads on the first approval preview (M4 step 5).
const loadUnpdf = lazyImplementation('The PDF page rasterizer (unpdf)', () => import('unpdf'))

let pdfJsReady: Promise<void> | undefined

function ensurePdfJs(definePDFJSModule: Awaited<ReturnType<typeof loadUnpdf>>['definePDFJSModule']): Promise<void> {
  pdfJsReady ??= definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
  return pdfJsReady
}

export async function renderPdfApprovalPage(
  bytes: Uint8Array,
  pageNumber: number,
  width = 1_400,
): Promise<Buffer> {
  const { definePDFJSModule, getDocumentProxy, renderPageAsImage } = await loadUnpdf()
  await ensurePdfJs(definePDFJSModule)
  const document = await getDocumentProxy(new Uint8Array(bytes))
  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
      throw new Error('PDF approval preview page is unavailable')
    }
    const png = await renderPageAsImage(document, pageNumber, {
      canvasImport: () => import('@napi-rs/canvas'),
      width: Math.max(320, Math.min(2_400, Math.floor(width))),
    })
    return Buffer.from(png)
  } finally {
    await document.destroy()
  }
}
