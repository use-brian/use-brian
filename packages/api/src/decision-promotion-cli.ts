/**
 * Dry-run-first operator interface for classifier profile approval/revocation.
 *
 * [COMP:decisions/promotion-registry]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseDecisionPromotionBundle,
  type DecisionPromotionBundle,
} from './decision-promotion.js'
import type {
  ApprovedDecisionProfileSummary,
  DecisionEvaluationProfileStore,
} from './db/decision-evaluation-profiles.js'

export type PromoteDecisionProfileCliOptions = {
  profilePath: string
  reportPath: string
  approvedBy: string
  apply: boolean
}

export type RevokeDecisionProfileCliOptions = {
  profileId: string
  profileVersion: string
  revokedBy: string
  reason: string
  apply: boolean
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag}=<value> is required`)
  return value.trim()
}

export function parsePromoteDecisionProfileArgs(
  args: readonly string[],
): PromoteDecisionProfileCliOptions {
  let profilePath: string | undefined
  let reportPath: string | undefined
  let approvedBy: string | undefined
  let apply = false
  for (const arg of args) {
    if (arg === '--apply') apply = true
    else if (arg.startsWith('--profile=')) profilePath = arg.slice('--profile='.length)
    else if (arg.startsWith('--report=')) reportPath = arg.slice('--report='.length)
    else if (arg.startsWith('--approved-by=')) approvedBy = arg.slice('--approved-by='.length)
    else throw new Error(`unknown decision promotion argument: ${arg}`)
  }
  return {
    profilePath: required(profilePath, '--profile'),
    reportPath: required(reportPath, '--report'),
    approvedBy: required(approvedBy, '--approved-by'),
    apply,
  }
}

export function parseRevokeDecisionProfileArgs(
  args: readonly string[],
): RevokeDecisionProfileCliOptions {
  let profileId: string | undefined
  let profileVersion: string | undefined
  let revokedBy: string | undefined
  let reason: string | undefined
  let apply = false
  for (const arg of args) {
    if (arg === '--apply') apply = true
    else if (arg.startsWith('--id=')) profileId = arg.slice('--id='.length)
    else if (arg.startsWith('--version=')) profileVersion = arg.slice('--version='.length)
    else if (arg.startsWith('--revoked-by=')) revokedBy = arg.slice('--revoked-by='.length)
    else if (arg.startsWith('--reason=')) reason = arg.slice('--reason='.length)
    else throw new Error(`unknown decision revocation argument: ${arg}`)
  }
  return {
    profileId: required(profileId, '--id'),
    profileVersion: required(profileVersion, '--version'),
    revokedBy: required(revokedBy, '--revoked-by'),
    reason: required(reason, '--reason'),
    apply,
  }
}

export function loadDecisionPromotionBundle(
  profilePath: string,
  reportPath: string,
): DecisionPromotionBundle {
  const profile = JSON.parse(readFileSync(resolve(profilePath), 'utf8')) as unknown
  const report = JSON.parse(readFileSync(resolve(reportPath), 'utf8')) as unknown
  return parseDecisionPromotionBundle(profile, report)
}

type PromotionStorePort = Pick<DecisionEvaluationProfileStore, 'promote' | 'revoke'>

export async function runPromoteDecisionProfileCli(
  args: readonly string[],
  options: {
    store?: PromotionStorePort
    write?: (message: string) => void
  } = {},
): Promise<ApprovedDecisionProfileSummary | null> {
  const cli = parsePromoteDecisionProfileArgs(args)
  const bundle = loadDecisionPromotionBundle(cli.profilePath, cli.reportPath)
  const write = options.write ?? console.log
  const summary = `${bundle.profile.id}@${bundle.profile.version} for ${bundle.profile.operationId} `
    + `(${bundle.profile.evaluationSegment}) on ${bundle.profile.modelCatalogId}`
  if (!cli.apply) {
    write(`Promotion preflight passed: ${summary}. Re-run with --apply to write it.`)
    return null
  }
  if (!options.store) throw new Error('decision promotion apply requires a database store')
  const promoted = await options.store.promote({
    profile: bundle.profile,
    report: bundle.report,
    approvedBy: cli.approvedBy,
  })
  write(`Promoted decision profile ${promoted.id}@${promoted.version}.`)
  return promoted
}

export async function runRevokeDecisionProfileCli(
  args: readonly string[],
  options: {
    store?: PromotionStorePort
    write?: (message: string) => void
  } = {},
): Promise<boolean | null> {
  const cli = parseRevokeDecisionProfileArgs(args)
  const write = options.write ?? console.log
  if (!cli.apply) {
    write(`Revocation preflight passed: ${cli.profileId}@${cli.profileVersion}. Re-run with --apply to write it.`)
    return null
  }
  if (!options.store) throw new Error('decision revocation apply requires a database store')
  const revoked = await options.store.revoke({
    profileId: cli.profileId,
    profileVersion: cli.profileVersion,
    revokedBy: cli.revokedBy,
    reason: cli.reason,
  })
  if (!revoked) throw new Error('decision profile was not found or was already revoked')
  write(`Revoked decision profile ${cli.profileId}@${cli.profileVersion}.`)
  return true
}
