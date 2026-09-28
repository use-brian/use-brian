export type PdfEngineErrorCode =
  | 'pdf_too_large'
  | 'pdf_too_many_pages'
  | 'pdf_encrypted'
  | 'pdf_unsupported_feature'
  | 'pdf_existing_digital_signature'
  | 'pdf_malformed'
  | 'pdf_text_glyph_unsupported'
  | 'pdf_resource_unavailable'
  | 'pdf_output_invalid'

export class PdfEngineError extends Error {
  readonly code: PdfEngineErrorCode

  constructor(code: PdfEngineErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PdfEngineError'
    this.code = code
  }
}

export function isPdfEngineError(error: unknown): error is PdfEngineError {
  return error instanceof PdfEngineError
}
