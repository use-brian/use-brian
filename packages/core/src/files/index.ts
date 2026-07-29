export type { FileStore, CachedFile } from './types.js'
export { parseFileContent, parseDocxToMarkdown, shouldInline } from './parsers.js'
export { distillFileToText, type DistillOptions, type DistillResult } from './distill.js'
export { extractPdfText } from './pdf-text.js'
export { renderPdfPages, probePdfPageCount, type RenderedPdfPage, type RenderPdfPagesResult } from './pdf-pages.js'
export {
  distillPdfViaPages,
  distillConfigKey,
  DASHSCOPE_CHUNK_PAGES,
  DASHSCOPE_RENDER_WIDTH,
  PROVIDER_CHUNK_PAGES,
  PROVIDER_RENDER_WIDTH,
  MAX_DISTILL_PAGES,
  PDF_CONFIRM_PAGE_THRESHOLD,
  estimateDistillTokens,
  type DistillPdfOptions,
  type DistillPdfResult,
  type VisionCaller,
} from './pdf-distill.js'
export { createReadFileTool } from './tool.js'
export { docxToBlocks } from './docx-convert.js'
