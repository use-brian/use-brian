/**
 * Which uploaded files can be rendered as a PDF preview server-side.
 *
 * Client-side mirror of the structured-document registry the API converts
 * through the ONE LibreOffice runner (`@use-brian/core`
 * `files/document-formats.ts` → `GET /api/files/:id/preview-pdf` and the
 * brain content route's `?as=pdf`). Deliberately extension-first, like the
 * server's `documentFormatFromMetadata`: browsers report office mimes
 * inconsistently (a `.docx` often arrives as `application/octet-stream`),
 * while the filename extension survives. PDFs and images are NOT in this set —
 * their bytes are previewed client-side without conversion.
 *
 * Part of `[COMP:app-web/message-attachment-card]` (chat cards) and the brain
 * detail drawer's file preview.
 */

const CONVERTIBLE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "docm",
  "odt",
  "rtf",
  "epub",
  "csv",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "ods",
  "ppt",
  "pps",
  "pot",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "odp",
]);

const CONVERTIBLE_MIMES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf",
  "application/epub+zip",
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.presentation",
]);

/** True when the server can render this file as a PDF preview. */
export function hasConvertiblePdfPreview(mime: string, name: string): boolean {
  const ext = name.toLowerCase().split(".").pop();
  if (ext && ext !== name.toLowerCase() && CONVERTIBLE_EXTENSIONS.has(ext)) return true;
  return CONVERTIBLE_MIMES.has(mime.toLowerCase().split(";")[0]!.trim());
}
