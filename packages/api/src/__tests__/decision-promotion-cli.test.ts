import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionEvaluationProfile } from '@use-brian/core'
import {
  parsePromoteDecisionProfileArgs,
  parseRevokeDecisionProfileArgs,
  runPromoteDecisionProfileCli,
  runRevokeDecisionProfileCli,
} from '../decision-promotion-cli.js'
import {
  SYNTHETIC_EVALUATION_PROFILES,
  runDecisionEvaluation,
  type DecisionEvaluationReport,
} from '../decision-evaluation.js'

const scratchDirs: string[] = []

afterEach(() => {
  for (const path of scratchDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function artifactFiles(): Promise<{ profilePath: string; reportPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'decision-promotion-test-'))
  scratchDirs.push(dir)
  const offline = await runDecisionEvaluation({ mode: 'offline' })
  const profile = {
    ...SYNTHETIC_EVALUATION_PROFILES[0]!,
    id: 'approved-research-intent',
    mode: 'hybrid',
    status: 'approved',
    evidence: 'recorded',
  } as DecisionEvaluationProfile
  const report = {
    ...offline,
    mode: 'live',
    evidence: 'recorded',
    mockedData: false,
    productionPromotionEvidence: true,
  } as DecisionEvaluationReport
  const profilePath = join(dir, 'profile.json')
  const reportPath = join(dir, 'report.json')
  writeFileSync(profilePath, JSON.stringify(profile))
  writeFileSync(reportPath, JSON.stringify(report))
  return { profilePath, reportPath }
}

describe('[COMP:decisions/promotion-registry] decision promotion CLI', () => {
  it('parses explicit dry-run/apply arguments and rejects unknown flags', () => {
    expect(parsePromoteDecisionProfileArgs([
      '--profile=/tmp/profile.json',
      '--report=/tmp/report.json',
      '--approved-by=operator-fixture',
      '--apply',
    ])).toEqual({
      profilePath: '/tmp/profile.json',
      reportPath: '/tmp/report.json',
      approvedBy: 'operator-fixture',
      apply: true,
    })
    expect(parseRevokeDecisionProfileArgs([
      '--id=profile-fixture',
      '--version=2',
      '--revoked-by=operator-fixture',
      '--reason=superseded',
    ])).toEqual({
      profileId: 'profile-fixture',
      profileVersion: '2',
      revokedBy: 'operator-fixture',
      reason: 'superseded',
      apply: false,
    })
    expect(() => parsePromoteDecisionProfileArgs(['--unknown'])).toThrow(/unknown/)
  })

  it('validates promotion artifacts without writing unless --apply is explicit', async () => {
    const { profilePath, reportPath } = await artifactFiles()
    const promote = vi.fn().mockResolvedValue({
      id: 'approved-research-intent',
      version: '1',
    })
    const write = vi.fn()
    const args = [
      `--profile=${profilePath}`,
      `--report=${reportPath}`,
      '--approved-by=operator-fixture',
    ]

    await expect(runPromoteDecisionProfileCli(args, {
      store: { promote, revoke: vi.fn() } as never,
      write,
    })).resolves.toBeNull()
    expect(promote).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/preflight passed/))

    await runPromoteDecisionProfileCli([...args, '--apply'], {
      store: { promote, revoke: vi.fn() } as never,
      write,
    })
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({
      approvedBy: 'operator-fixture',
    }))
  })

  it('keeps revocation dry-run by default', async () => {
    const revoke = vi.fn().mockResolvedValue(true)
    const args = [
      '--id=profile-fixture',
      '--version=1',
      '--revoked-by=operator-fixture',
      '--reason=superseded',
    ]
    await expect(runRevokeDecisionProfileCli(args, {
      store: { promote: vi.fn(), revoke } as never,
      write: vi.fn(),
    })).resolves.toBeNull()
    expect(revoke).not.toHaveBeenCalled()
  })
})
