import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('[COMP:api/native-turn-frame] registry guard successor source', () => {
  it('reproduces 8276 from its pinned predecessors and keeps 8274 reproducible', () => {
    expect(() => execFileSync(process.execPath, [directory + 'build-registry-guard-successor.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(() => execFileSync(process.execPath, [directory + 'build-executable-record.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })
  it('keeps the 8274 authenticator as a frozen named predecessor', () => {
    expect(sha(directory + 'installation-authentication-8274.mjs')).toBe('3eafc55a2487af0ac3ac04310bfd51063adda2ed8c77bc81e26f847a3b1df5c3')
  })
  it('renders a fast path that holds no installation literal and stores no decision', async () => {
    const { guardFastPath, refreshBody, enrolledSignatures } = await import(directory + 'registry-guard-successor.mjs')
    expect(enrolledSignatures).toEqual(['capture_conversation_preparation(uuid,jsonb,jsonb,jsonb)', 'native_turn_contract_witness_refresh()'])
    // Only source names and typed live catalog identities; no OIDs, hashes or xids.
    expect(guardFastPath).not.toMatch(/\b\d{4,}\b|[0-9a-f]{64}/)
    expect(guardFastPath).not.toMatch(/\b(INSERT|UPDATE|DELETE|set_config)\b/i)
    // The refresh records identities in the same statement as a passing full comparison.
    expect(refreshBody).toMatch(/INSERT INTO public\.native_turn_contract_witness[\s\S]*WHERE public\.native_turn_helpers_current\(\) IS TRUE/)
  })
})
