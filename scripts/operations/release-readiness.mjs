import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hash } from './readiness-contract.mjs'

/** Pure evidence validator. A fixture pass says nothing about installed authority. */
export function assessReleaseEvidence(e) {
  const reasons = []
  if (!/^[a-f0-9]{40}$/.test(e?.candidate?.sha ?? '') || !e.candidate.ref) reasons.push('candidate_missing')
  const sha = e?.candidate?.sha
  for (const name of e?.requiredChecks ?? []) {
    const check = e.checks?.find(c => c.name === name)
    if (!check || check.sha !== sha || check.status !== 'passed' || check.skipped || !check.artifactHash) reasons.push(`required_check:${name}`)
  }
  if (!e?.requiredChecks?.length) reasons.push('required_checks_unknown')
  if (!e?.artifacts?.length || e.artifacts.some(a => a.sha !== sha || a.target !== e.target || !/^[a-f0-9]{64}$/.test(a.sha256 ?? ''))) reasons.push('artifact_identity')
  if (!e?.target || !e?.actor?.kind || !e.actor.id) reasons.push('target_or_actor_missing')
  if (!e?.route?.source || e.route.target !== e.target || e.route.actorId !== e?.actor?.id || e.route.sha !== sha || !['automatic', 'manual'].includes(e.route.kind)) reasons.push('route_identity')
  if (e?.route?.available !== true || e.route.authorized !== true || e.route.policyVerified !== true || !e.route.permissionEvidence) reasons.push('action_route_missing_or_unverified')
  if (e?.actor?.kind === 'brian' && !e?.route?.nativePolicyEvidence) reasons.push('brian_native_policy_missing')
  if (e?.remoteSettings !== 'verified') reasons.push('remote_settings_not_checked')
  if (!e?.health?.verified || e.health.sha !== sha || e.health.target !== e.target) reasons.push('health_not_verified')
  if (!e?.rollback?.verified || e.rollback.target !== e.target || !e.rollback.receipt) reasons.push('rollback_not_verified')
  if (e?.evidenceClass !== 'fixture') reasons.push('live_evidence_not_collected_by_this_package')
  return { status: reasons.length ? 'blocked' : 'fixture_verified',
    localEvidenceValid: reasons.length === 0, liveVerified: false, reasons }
}

const sources = [
  ['oss', '.github/workflows/ci.yml'], ['oss', '.github/workflows/desktop-release.yml'], ['oss', '.github/workflows/docker-images.yml'],
  ['oss', 'apps/app-desktop/scripts/release.mjs'], ['oss', 'packages/core/src/tools/base/github.ts'], ['oss', 'packages/api/src/github/client.ts'],
  ['oss', 'packages/api/src/mcp/inject.ts'], ['oss', 'packages/shared/src/builtin-connectors.ts'],
  ['oss', 'packages/core/src/approval-review/contracts.ts'],
  ['platform', 'scripts/deploy-api.sh'], ['platform', 'scripts/lib/build-context.sh'], ['platform', 'scripts/vercel-submodule-bootstrap.mjs'],
  ['platform', 'vercel.json'],
]

export async function inspectRelease(ossRoot, platformRoot, source) {
  const inventory = [], contents = {}
  for (const [repo, path] of sources) {
    try {
      const bytes = await readFile(join(repo === 'oss' ? ossRoot : platformRoot, path))
      if (bytes.length > 2_000_000) throw new Error('source_bound')
      inventory.push({ repo, path, sha256: hash(bytes), status: 'source_supported' }); contents[path] = bytes.toString()
    } catch { inventory.push({ repo, path, status: 'blocked', reason: 'source_missing' }) }
  }
  const github = contents['packages/core/src/tools/base/github.ts'] ?? ''
  const toolNames = [...github.matchAll(/name:\s*'(github[^']+)'/g)].map(m => m[1])
  const hasReleaseWriter = toolNames.some(n => /merge|dispatch|release|deploy/i.test(n))
  const ci = contents['.github/workflows/ci.yml'] ?? ''
  const desktop = contents['.github/workflows/desktop-release.yml'] ?? ''
  const deploy = contents['scripts/deploy-api.sh'] ?? ''
  const facts = {
    ciMainDevelop: /branches:\s*\[main, develop\]/.test(ci), aggregateCheck: /\n  build-test:/.test(ci),
    desktopMainCiGate: /workflow_run/.test(desktop) && /conclusion == 'success'/.test(desktop) && /head_branch == 'main'/.test(desktop),
    desktopManualPath: /workflow_dispatch/.test(desktop), desktopScriptChecksCurrentMainCi: /function checkProduction/.test(contents['apps/app-desktop/scripts/release.mjs'] ?? ''),
    containerPublicationIsDeployment: false, hostedManualMigrationsDefaultOn: /MIGRATE=true/.test(deploy),
    hostedHealthOnly: /\/health/.test(deploy), githubTools: toolNames, builtinReleaseWriter: hasReleaseWriter,
  }
  const routes = [
    { id: 'oss-promotion', target: 'oss-main', source: '.github/workflows/ci.yml', kind: 'manual', actor: 'maintainer-or-explicitly-authorized-brian',
      support: facts.ciMainDevelop ? 'source_supported' : 'blocked', status: 'blocked', reason: 'candidate_matching_remote_checks_protection_and_shared_release_action_route_not_verified',
      credentials: 'Maintainer/Brian release authority and native policy evidence not checked; connector file-write/configure cannot supply it.',
      health: 'Required CI evidence for exact promoted SHA and subsequent target verification owed.', rollback: 'Reviewed previous ref/artifact and guarded rollback route owed.' },
    { id: 'desktop', target: 'desktop', source: '.github/workflows/desktop-release.yml', kind: 'automatic-with-manual-dispatch', actor: 'ci-release-principal',
      support: facts.desktopMainCiGate && facts.desktopScriptChecksCurrentMainCi ? 'source_supported' : 'blocked', status: 'live_unverified', reason: 'candidate_ci_artifacts_environment_signing_and_dispatch_authority_not_checked',
      credentials: 'Workflow environment signing/release secrets and permission configuration require separate verification.',
      health: 'Exact-SHA signed installer/update feed verification owed.', rollback: 'Known-good installer/feed recovery must be verified.' },
    { id: 'images', target: 'container-registry', source: '.github/workflows/docker-images.yml', kind: 'automatic-or-manual-publication', actor: 'ci-package-principal',
      support: contents['.github/workflows/docker-images.yml'] ? 'source_supported' : 'blocked', status: 'live_unverified', reason: 'image_publication_does_not_certify_target_deployment',
      credentials: 'Registry publish authority unknown; does not grant deployment authority.', health: 'Image provenance/digest is insufficient for installed health.', rollback: 'Target-specific immutable previous digest and recovery owed.' },
    { id: 'hosted-api', target: 'platform', source: 'scripts/deploy-api.sh + scripts/lib/build-context.sh', kind: 'manual', actor: 'maintainer',
      support: deploy ? 'source_supported' : 'blocked', status: 'blocked', reason: 'shared_brian_target_route_and_exact_sha_checks_missing',
      credentials: 'Cloud build/deployment/database roles unknown; no secrets read.', health: '/health exists but alone does not prove usable application/database.',
      rollback: 'Script does not establish a tested rollback receipt; source/schema compatibility and previous revision recovery owed.' },
    { id: 'personal-self-host', target: 'home-linux', source: 'docs/architecture/platform/deployment.md (target kit in sibling deploy-brian)', kind: 'manual', actor: 'installation-maintainer',
      support: 'blocked', status: 'blocked', reason: 'installed_pin_target_credentials_health_rollback_and_brian_route_not_checked',
      credentials: 'Owner supplies exact installed target and allowed fixed-pipeline principal; no personal account substituted.',
      health: 'Disposable readiness fixture is not installed target verification.', rollback: 'Verified installed previous artifact/schema-compatible recovery owed.' },
  ]
  return { schema: 'operations-release-readiness-v1', candidate: { oss: source.oss.sha, platform: source.platform.sha, ref: source.oss.branch, platformRef: source.platform.branch },
    sourceDigest: source.digest, inventory, facts, routes, requiredChecks: ['build-test (source-declared; remote protection not checked)'],
    checks: [], artifacts: [], remoteSettings: 'not_checked', installedRoutes: 'not_checked', verdict: 'not_ready',
    releasePolicy: 'native workspace/assistant/credential checks and human-only security/payment exceptions apply; no new authority',
    gaps: routes.filter(r => r.status === 'blocked').map(r => ({ id: r.id, source: r.source, missing: r.reason,
      accountableRole: r.id === 'personal-self-host' ? 'installation owner and senior engineer' : 'senior engineer and release maintainer',
      smallestRepair: hasReleaseWriter ? 'Verify the selected current permitted release route against candidate, actor and target.'
        : 'Design a bounded shared maintainer/Brian release action route with exact-SHA checks, native policy, effect receipt, health and rollback; implement under a subsequent release Goal.',
      acceptance: `Prove candidate SHA, all required checks, immutable artifact, ${r.target} identity, both permitted actors, denial/replay, health and rollback in a no-effect fixture.`,
      activationPrerequisite: 'Close implementation gaps, then separately authorize remote/installed verification and owner binding.' })) }
}
