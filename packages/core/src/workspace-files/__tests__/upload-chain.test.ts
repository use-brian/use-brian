import { describe, it, expect } from 'vitest'
import { errorMessage, isBinaryMime } from '../tool-helpers.js'
import { buildUploadPolicyBlock } from '../upload-policy-block.js'

/**
 * The upload → save → reuse chain. Every assertion here traces to the
 * 2026-08-05 Telegram incident, where a model passed two `<attached_file>`
 * ids straight to `gmailSendMessage(attachments)` and got a flat
 * "File <uuid> not found in this workspace." with no route forward.
 */

describe('[COMP:files/tools] not_found routes an upload id to the save step', () => {
  it('tells the model a bare UUID is probably an upload, and what to do', () => {
    const msg = errorMessage({
      kind: 'not_found',
      reference: 'f8079ca6-35e7-4403-80e4-0807890070bc',
    } as never)
    // Names the actual confusion instead of just failing.
    expect(msg).toContain('<attached_file')
    expect(msg).toContain('UPLOADED attachment')
    // States the remedy...
    expect(msg).toMatch(/saved into the workspace files first|save/i)
    // ...and the fallback when the assistant has no save tool, which is the
    // capability-less case that produced the incident.
    expect(msg).toContain('Capabilities')
    // Honesty floor — the whole point is not shipping a false claim.
    expect(msg).toContain('never claim a file was attached when it was not')
  })

  it('is tool-agnostic — names no tool that may not be injected', () => {
    const msg = errorMessage({
      kind: 'not_found',
      reference: 'f8079ca6-35e7-4403-80e4-0807890070bc',
    } as never)
    // Layer-1 tool-awareness rule: an assistant without `files` has no
    // promote tool, and naming one it cannot call is the exact trap.
    for (const tool of ['saveFileToBrain', 'saveFileBytes', 'fileWrite', 'sendFile', 'ingestFile']) {
      expect(msg).not.toContain(tool)
    }
  })

  it('leaves a PATH miss alone — that is a genuine miss, not an upload', () => {
    const msg = errorMessage({ kind: 'not_found', reference: '/notes/q3.md' } as never)
    expect(msg).toBe('File /notes/q3.md not found in this workspace.')
    expect(msg).not.toContain('<attached_file')
  })

  it('accepts an uppercase UUID (ids are not case-normalized upstream)', () => {
    const msg = errorMessage({
      kind: 'not_found',
      reference: 'F8079CA6-35E7-4403-80E4-0807890070BC',
    } as never)
    expect(msg).toContain('UPLOADED attachment')
  })
})

describe('[COMP:files/tools] binary mime classification', () => {
  it('treats real text as readable', () => {
    for (const m of [
      'text/plain', 'text/markdown', 'text/csv', 'application/json',
      'application/xml', 'application/yaml', 'application/ld+json',
      'text/plain; charset=utf-8',
    ]) {
      expect(isBinaryMime(m), m).toBe(false)
    }
  })

  it('treats media and unknown types as binary — the default must be refuse', () => {
    for (const m of [
      'image/png', 'image/jpeg', 'application/pdf', 'audio/mpeg', 'video/mp4',
      'application/octet-stream', 'application/zip',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/x-some-format-invented-next-year',
    ]) {
      expect(isBinaryMime(m), m).toBe(true)
    }
  })
})

describe('[COMP:files/upload-policy-block] # Saving uploaded files', () => {
  it('is empty without the files capability — never advertise a missing tool', () => {
    expect(buildUploadPolicyBlock(false)).toBe('')
  })

  it('teaches the upload-id-is-not-a-file-reference rule', () => {
    const block = buildUploadPolicyBlock(true)
    expect(block).toContain('# Saving uploaded files')
    expect(block).toContain('An upload id is NOT a stored-file reference')
    // The forward case (the incident) as well as the save case.
    expect(block).toMatch(/attaching it to an email/)
    expect(block).toMatch(/forward, share, or attach/)
    // No memory substitution, no false success.
    expect(block).toContain('Do NOT record a memory as a substitute')
    expect(block).toContain('do not describe the file as attached')
  })

  it('names no tool (Layer-1 tool-awareness rule)', () => {
    const block = buildUploadPolicyBlock(true)
    for (const tool of ['saveFileToBrain', 'sendFile', 'gmailSendMessage', 'saveMemory', 'fileWrite']) {
      expect(block).not.toContain(tool)
    }
  })
})
