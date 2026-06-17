/**
 * FileIngestError — OPEN. A typed error thrown by the file ingestor and matched
 * (`instanceof`) by the OPEN file-upload route (routes/files.ts) for
 * quota/conflict handling. Relocated out of the closed `files/ingest-file.ts`
 * (which does the closed Pipeline-B extraction) so the open route can import it
 * without a closed dependency. See oss §12.5.
 */
export class FileIngestError extends Error {
  constructor(
    readonly kind: string,
    readonly detail: unknown,
  ) {
    super(`File ingest failed: ${kind}`)
    this.name = 'FileIngestError'
  }
}
