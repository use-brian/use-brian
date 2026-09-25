import { vi } from 'vitest'
import type { StructuredOcrClient } from '../client.js'
import type { ConnectorBinding, StructuredOcrConnectorResolver } from '../connector.js'
export const connectorInstanceId = '49000000-0000-4000-8000-000000000090'
export const binding: ConnectorBinding = { connectorInstanceId, endpointHash: 'a'.repeat(64), credentialFingerprint: 'b'.repeat(64), policyFingerprint: 'c'.repeat(64), protocol: 'ocr-evidence/1' }
export function connectorsStub(client: StructuredOcrClient) {
  return {
    list: vi.fn<StructuredOcrConnectorResolver['list']>(async () => [{ connectorInstanceId, label: 'Fictional OCR' }]),
    resolve: vi.fn<StructuredOcrConnectorResolver['resolve']>(async () => ({ client, binding, label: 'Fictional OCR' })),
  }
}
