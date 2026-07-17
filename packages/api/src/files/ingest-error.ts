/**
 * FileIngestError — OPEN. A typed error thrown by the file ingestor and matched
 * (`instanceof`) by the file-upload route (routes/files.ts) for quota/conflict
 * handling.
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
