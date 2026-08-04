import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'

import {
  inspectLinkedInArchive,
  LinkedInArchiveError,
  MAX_LINKEDIN_MEMBERS,
  normalizeMemberPath,
  sha256,
} from '../archive.js'

describe('[COMP:brain/linkedin-import] LinkedIn ZIP safety', () => {
  it('extracts exact member bytes, hashes, MIME types, and stable path order', async () => {
    const zip = new JSZip()
    zip.file('Profile.csv', 'First Name,Last Name\nBrian,Lee\n')
    zip.file('Jobs/Saved Jobs.csv', 'Job Title\nFounder\n')
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

    const members = await inspectLinkedInArchive(bytes)
    expect(members.map((member) => member.path)).toEqual(['Jobs/Saved Jobs.csv', 'Profile.csv'])
    expect(members[0]).toMatchObject({ mime: 'text/csv', sizeBytes: 18 })
    expect(members[1].contentSha256).toBe(sha256(Buffer.from('First Name,Last Name\nBrian,Lee\n')))
    expect(members.every((member) => typeof member.compressedSize === 'number')).toBe(true)
  })

  it('rejects traversal, absolute, drive, backslash, and empty-segment paths', () => {
    for (const path of ['../secret.csv', '/root.csv', 'C:/root.csv', 'a\\b.csv', 'a//b.csv']) {
      expect(() => normalizeMemberPath(path)).toThrow(LinkedInArchiveError)
    }
  })

  it('checks the unsafe original name even though JSZip sanitizes traversal', async () => {
    const zip = new JSZip()
    zip.file('../escape.csv', 'x\n1\n')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(inspectLinkedInArchive(bytes)).rejects.toMatchObject({ kind: 'unsafe_path' })
  })

  it('rejects archives with too many files before extracting bodies', async () => {
    const zip = new JSZip()
    for (let i = 0; i <= MAX_LINKEDIN_MEMBERS; i += 1) zip.file(`f-${i}.csv`, '')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(inspectLinkedInArchive(bytes)).rejects.toMatchObject({ kind: 'too_many_members' })
  })

  it('rejects non-ZIP bytes with a typed error', async () => {
    await expect(inspectLinkedInArchive(Buffer.from('not a zip'))).rejects.toMatchObject({ kind: 'invalid_zip' })
  })
})
