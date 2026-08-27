import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

describe('[COMP:ext/agent] Chromium browser-control explanation', () => {
  const allowHtml = read('../../static/allow.html')
  const popupHtml = read('../../static/popup.html')
  const allowSource = read('../allow.ts')
  const firefoxAllowHtml = read('../../static-firefox/allow.html')

  it('explains Chrome\'s debugging label before browser control starts', () => {
    expect(allowHtml).toContain('Chrome labels active browser control as "debugging this browser."')
    expect(allowSource).toContain('Chrome labels active browser control as "debugging this browser."')
  })

  it('keeps the explanation visible when tab control is pre-approved', () => {
    expect(popupHtml).toContain('Chrome labels active browser control as "debugging this browser."')
  })

  it('does not show Chromium-specific wording in the Firefox consent flow', () => {
    expect(firefoxAllowHtml).not.toContain('debugging this browser')
  })
})
