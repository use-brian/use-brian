/** Bounded, non-ingested CRM submission image normalization. [COMP:crm/submission-attachments] */
import { createHash } from 'node:crypto'
import { lazyImplementation } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import {
  CrmOperationsError,
  type CrmIntakeAttachmentPolicy,
  type CrmSubmissionAttachment,
} from './operations-types.js'

export type PreparedCrmSubmissionAttachment = {
  key: string
  originalName: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp'
  contentBytes: Buffer
  sizeBytes: number
  sha256: string
}

// The image normalizer loads on the first submission with attachments, not
// when the CRM operations service is built (M4 step 5, D13).
const loadSharp = lazyImplementation('The image normalizer (sharp)', () => import('sharp').then((m) => m.default))

const formats = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const

function invalid(message: string, key?: string): never {
  throw new CrmOperationsError('invalid_input', message, key ? { attachmentKey: key } : {})
}

async function normalize(
  attachment: CrmSubmissionAttachment,
  policy: CrmIntakeAttachmentPolicy,
): Promise<PreparedCrmSubmissionAttachment> {
  const input = Buffer.from(attachment.contentBase64, 'base64')
  if (!input.length || input.toString('base64') !== attachment.contentBase64) {
    invalid('Attachment content is not canonical base64.', attachment.key)
  }
  if (input.length > policy.maxBytes) invalid('Attachment exceeds its configured byte limit.', attachment.key)
  if (!policy.mimeTypes.includes(attachment.mimeType)) invalid('Attachment MIME type is not allowed.', attachment.key)

  // Outside the catch below: an unavailable normalizer is not an invalid image.
  const sharp = await loadSharp()
  let output: Buffer
  try {
    const image = sharp(input, { failOn: 'warning', limitInputPixels: 25_000_000, sequentialRead: true }).rotate()
    const metadata = await image.metadata()
    if (metadata.format !== formats[attachment.mimeType] || !metadata.width || !metadata.height) {
      invalid('Attachment bytes do not match the declared image type.', attachment.key)
    }
    if (metadata.width > 10_000 || metadata.height > 10_000) {
      invalid('Attachment dimensions exceed the configured safety limit.', attachment.key)
    }
    output = attachment.mimeType === 'image/png'
      ? await image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : attachment.mimeType === 'image/webp'
        ? await image.webp({ quality: 90 }).toBuffer()
        : await image.jpeg({ quality: 90, mozjpeg: true }).toBuffer()
  } catch (error) {
    if (error instanceof CrmOperationsError) throw error
    invalid('Attachment is not a valid supported image.', attachment.key)
  }
  if (output.length > policy.maxBytes) invalid('Normalized attachment exceeds its configured byte limit.', attachment.key)
  return {
    key: attachment.key,
    originalName: attachment.name,
    mimeType: attachment.mimeType,
    contentBytes: output,
    sizeBytes: output.length,
    sha256: createHash('sha256').update(output).digest('hex'),
  }
}

export async function prepareCrmSubmissionAttachments(
  attachments: readonly CrmSubmissionAttachment[],
  policies: readonly CrmIntakeAttachmentPolicy[],
): Promise<PreparedCrmSubmissionAttachment[]> {
  const suppliedKeys = new Set(attachments.map((attachment) => attachment.key))
  if (suppliedKeys.size !== attachments.length) invalid('Each attachment key may be supplied once.')
  for (const policy of policies) {
    if (policy.required && !suppliedKeys.has(policy.key)) invalid('A required attachment is missing.', policy.key)
  }
  const policyByKey = new Map(policies.map((policy) => [policy.key, policy]))
  return Promise.all(attachments.map((attachment) => {
    const policy = policyByKey.get(attachment.key)
    if (!policy) invalid('Attachment is not declared by this intake definition.', attachment.key)
    return normalize(attachment, policy)
  }))
}
