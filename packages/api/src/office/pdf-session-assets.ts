/** PDF session asset validation and byte-only storage contracts.
 * [COMP:api/office-pdf-sessions] [COMP:api/office-pdf-purge] */
export {
  PDF_SIGNATURE_MAX_BYTES,
  PDF_SIGNATURE_MAX_DIMENSION,
  PdfSignatureImageError,
  normalizePdfSignatureImage,
  type NormalizedPdfSignature,
} from '@use-brian/core'

export type PdfSessionAssetRole = 'source' | 'signature' | 'snapshot' | 'preview' | 'release'

export type PdfSessionStoredFile = {
  id: string
  path: string
  storageUri: string
  mime: string
  sha256: string
}

export type PdfSessionAssetPort = {
  write(params: {
    fileId?: string
    userId: string
    workspaceId: string
    path: string
    bytes: Uint8Array
    mime: string
    sensitivity: 'public' | 'internal' | 'confidential'
    compartments: string[]
    projectIds: string[]
    metadata: { officeSession: true; noIndex: true }
  }): Promise<PdfSessionStoredFile>
  read(params: { userId: string; workspaceId: string; fileId: string }): Promise<{ bytes: Uint8Array; file: PdfSessionStoredFile } | null>
  delete(params: { userId: string; workspaceId: string; fileId: string }): Promise<void>
  saveDurable(params: {
    userId: string
    workspaceId: string
    path: string
    bytes: Uint8Array
    mime: 'application/pdf'
    sensitivity: 'public' | 'internal' | 'confidential'
    compartments: string[]
    projectIds: string[]
  }): Promise<{ id: string }>
}

export function pdfSessionAssetPath(artifactId: string, role: PdfSessionAssetRole, name: string): string {
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || role
  return `/office/sessions/${artifactId}/${role}/${safeName}`
}

export const PDF_SESSION_FILE_METADATA = { officeSession: true, noIndex: true } as const
