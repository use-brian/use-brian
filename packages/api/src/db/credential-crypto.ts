/**
 * Generic AES-256-GCM credential blob encryption — OPEN.
 *
 * Pure crypto (no DB, no env, no closed deps): encrypt/decrypt an arbitrary
 * JSON-serializable credential object to/from a `Buffer` blob (iv ‖ tag ‖
 * ciphertext). Relocated out of the closed `channel-integrations.ts` so the
 * OPEN connector stores (connector-store / connector-instance-store) can reuse
 * it without importing closed code. `channel-integrations.ts` keeps thin
 * `ChannelCredentials`-typed wrappers over these. See oss §12.5.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const IV_LENGTH = 12
const TAG_LENGTH = 16

export function encryptCredentials<T>(credentials: T, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

export function decryptCredentials<T>(blob: Buffer, key: Buffer): T {
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('credential-crypto: ciphertext blob too short — corrupted or wrong format')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8')) as T
}
