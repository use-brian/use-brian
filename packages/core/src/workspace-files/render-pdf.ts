/**
 * `renderPdf` — Brian produces a real PDF file. [COMP:files/render-pdf]
 *
 * The model authors the body as Markdown (or names an existing doc page);
 * the tool renders it through the doc-conversion PDF spoke
 * (`doc/convert/to-pdf.ts`: Block[] → .docx → headless LibreOffice → .pdf)
 * and persists the bytes as a workspace file via `FilesApi.writeBytes`. It
 * is the third authoring path beside `fileWrite` (UTF-8 text the model
 * writes) and `saveFileBytes` (bytes a programmatic caller already holds):
 * the model can *describe* a PDF but cannot emit valid PDF bytes itself, so
 * without this tool "send me a PDF" was answered with a Markdown paste.
 *
 * Delivery is NOT this tool's job. Like `fileWrite`, it only writes inside
 * the workspace and returns the file id; putting the document in the chat is
 * `sendFile`'s single gated path (channel capability, sensitivity, size
 * caps). The description tells the model to chain the two.
 *
 * Failure is honest: a deployment without LibreOffice gets
 * `converter_unavailable` in Brian's own words, never a blank or fake PDF,
 * and the tool never claims a render it did not verify (page count is read
 * back from the produced bytes).
 *
 * Spec: docs/architecture/features/files.md → "`renderPdf`" and
 * docs/architecture/features/doc-conversion.md → "PDF spoke".
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { FilesApi } from './api.js'
import { FILE_SENSITIVITIES, type FileSensitivity } from './types.js'
import { scopeEvidenceFromRows } from '../security/context-scope.js'
import {
  applyExplicitLinks,
  explicitLinksField,
  formatLinksSummary,
  type EntityLinksStore,
} from '../entities/index.js'
import type { Page } from '../doc/page-types.js'
import { PdfRenderError, defaultPdfRenderer, type PdfRenderer } from '../doc/convert/to-pdf.js'
import {
  ctxFor,
  errorMessage,
  policyBlockGate,
  policyConfirmation,
  workspaceGate,
  type ResolveFileToolPolicy,
} from './tool-helpers.js'

/** Upper bound on the Markdown body a single call may render. Generous for a
 *  report; a book-length body belongs in a doc page rendered by `pageId`. */
export const MAX_RENDER_PDF_MARKDOWN_CHARS = 200_000

export type RenderPdfDocPageReader = (
  userId: string,
  pageId: string,
) => Promise<{ title: string; page: Page } | null>

export type RenderPdfToolOptions = {
  resolvePolicy?: ResolveFileToolPolicy
  /** Wired at boot to the doc page store; absent → `pageId` input is refused honestly. */
  readDocPage?: RenderPdfDocPageReader
  /** The render seam — tests inject a fake; production uses LibreOffice. */
  renderer?: PdfRenderer
  entityLinks?: EntityLinksStore
  onFileCreated?: (
    event: { fileId: string; path: string; sizeBytes: number; pageCount: number },
    context: { userId: string; assistantId: string; sessionId: string; channelType: string },
  ) => void
}

const SENSITIVITY_VALUES = [...FILE_SENSITIVITIES] as [FileSensitivity, ...FileSensitivity[]]

/** Normalise the requested path to a `.pdf` file: strip a stray extension,
 *  add `.pdf`, and refuse an empty basename. */
export function normalizePdfPath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, '/')
  if (!trimmed) return null
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const parts = withSlash.split('/')
  const base = parts[parts.length - 1] ?? ''
  if (!base) return null
  const stem = base.replace(/\.pdf$/i, '')
  if (!stem) return null
  parts[parts.length - 1] = `${stem}.pdf`
  return parts.join('/')
}

export function createRenderPdfTool(api: FilesApi, opts?: RenderPdfToolOptions): Tool {
  const renderer = opts?.renderer ?? defaultPdfRenderer
  return buildTool({
    name: 'renderPdf',
    requiresCapability: 'files',
    // Writes only inside the workspace (never overwrites — a taken path is a
    // conflict) and the user has, by definition, just asked for a PDF; the
    // egress step stays separately gated by sendFile. Same reasoning as
    // saveFileToBrain's allow default; the boot-wired policy can still ask.
    requiresConfirmation: false,
    resolveConfirmation: policyConfirmation(opts?.resolvePolicy, 'renderPdf'),
    isConcurrencySafe: false,
    isReadOnly: false,
    // A LibreOffice render is a few seconds; the runner itself caps at 60s.
    timeoutMs: 90_000,
    description:
      'Produce a real PDF file and save it in the workspace. Give the document body as Markdown (headings, paragraphs, lists, tables, code) — you write the content, the tool renders it to a proper paged PDF — OR pass `pageId` to render an existing doc page instead. ' +
      'Use it whenever the user asks for a PDF (a report, proposal, summary, memo, invoice-style document, meeting notes) or asks to "send/give me this as a PDF". ' +
      'It only saves the file. To put the PDF in the chat, call sendFile next with the returned id — never paste the body into your reply as a substitute. ' +
      '`path` is the workspace-relative filename (a `.pdf` extension is added if missing) and must be unused; pick a descriptive one, e.g. "/reports/2026-Q3-sales-summary.pdf". ' +
      'If this tool returns an error (for example PDF rendering being unavailable on this deployment), relay the reason honestly and offer the Markdown or a Word export instead — never claim a PDF was made when it was not.',
    inputSchema: z
      .object({
        path: z.string().min(1).max(1024).describe('Workspace-relative path for the PDF, e.g. "/reports/2026-Q3-summary.pdf". Forward slashes; leading slash optional; ".pdf" appended if missing.'),
        markdown: z
          .string()
          .min(1)
          .max(MAX_RENDER_PDF_MARKDOWN_CHARS)
          .optional()
          .describe('The complete document body as Markdown. Required unless `pageId` is given.'),
        pageId: z.string().min(1).max(128).optional().describe('Render an existing doc page (its id) instead of `markdown`.'),
        title: z.string().min(1).max(256).optional().describe('Document title. Printed as the heading of the PDF when rendering Markdown; also the file title in the workspace. Defaults to the page title for `pageId`.'),
        summary: z.string().min(1).max(512).optional().describe('One-line description visible in the # Workspace Files block.'),
        tags: z.array(z.string().min(1).max(64)).max(20).optional(),
        sensitivity: z
          .enum(SENSITIVITY_VALUES)
          .optional()
          .describe('Defaults to internal. Confidential PDFs can only be sent in web chat.'),
        links: explicitLinksField,
      })
      .refine((v) => Boolean(v.markdown) !== Boolean(v.pageId), {
        message: 'Provide exactly one of `markdown` or `pageId`.',
      }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const policyGate = await policyBlockGate(opts?.resolvePolicy, 'renderPdf', context)
      if (policyGate) return policyGate

      const path = normalizePdfPath(input.path)
      if (!path) return { data: 'Invalid `path`: give a filename such as "/reports/summary.pdf".', isError: true }

      // ── Resolve the source ──
      let rendered: Awaited<ReturnType<PdfRenderer['fromMarkdown']>>
      let title = input.title?.trim() || undefined
      try {
        if (input.pageId) {
          if (!opts?.readDocPage) {
            return { data: 'Rendering a doc page to PDF is not available in this context — pass the content as `markdown` instead.', isError: true }
          }
          const page = await opts.readDocPage(context.userId, input.pageId)
          if (!page) {
            return { data: `Page not found or not accessible: ${input.pageId}. Check the id, or pass the content as \`markdown\`.`, isError: true }
          }
          title = title ?? page.title
          rendered = await renderer.fromPage(page.page, { title: page.title })
        } else {
          rendered = await renderer.fromMarkdown(input.markdown!, { title })
        }
      } catch (error) {
        if (error instanceof PdfRenderError) {
          console.warn(`[renderPdf] ${error.code}:`, error.cause ?? error.message)
          return {
            data: `${error.message} Offer the content as Markdown (or a Word export from the page header) instead, and say plainly that the PDF could not be produced.`,
            isError: true,
          }
        }
        throw error
      }

      // ── Persist ──
      const result = await api.writeBytes(ctxFor(context), {
        path,
        bytes: rendered.bytes,
        mime: 'application/pdf',
        title: title ?? null,
        summary: input.summary ?? null,
        tags: input.tags,
        sensitivity: input.sensitivity,
      })
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      const file = result.value
      opts?.onFileCreated?.(
        { fileId: file.id, path: file.path, sizeBytes: file.sizeBytes, pageCount: rendered.pageCount },
        { userId: context.userId, assistantId: context.assistantId, sessionId: context.sessionId, channelType: context.channelType },
      )
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'file',
        sourceId: file.id,
        source: 'user',
        links: input.links,
        compartments: file.compartments,
        projectIds: file.projectIds,
      })
      const pages = rendered.pageCount === 1 ? '1 page' : `${rendered.pageCount} pages`
      return {
        data:
          `Rendered ${file.path} (${pages}, ${file.sizeBytes} bytes, application/pdf). id=${file.id}${formatLinksSummary(linksSummary)}` +
          ` To deliver it in the chat, call sendFile with file="${file.id}".`,
        scopeEvidence: scopeEvidenceFromRows([file]),
      }
    },
  })
}
