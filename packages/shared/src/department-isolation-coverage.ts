/**
 * Versioned, executable coverage registry for departmental isolation.
 *
 * The manifest is intentionally data-only so the no-credential local runner and
 * the platform invariant can consume the same inventory. Runtime readiness may
 * derive compiled capability coverage from it, but never reads a test report.
 *
 * [COMP:api/department-isolation-lifecycle]
 */

export const DEPARTMENT_ISOLATION_MANIFEST_REVISION = 2

export const DEPARTMENT_ISOLATION_CASE_IDS = Object.freeze([
  'A01','A02','A03','A04','A05','A06','A07','A08','A09',
  'A10','A11','A12','A13','A14','A15','A16','A17','A18',
] as const)

export const DEPARTMENT_ISOLATION_REQUIRED_CAPABILITIES = Object.freeze([
  'row_store_coverage','turn_entry_points','write_inheritance','session_isolation',
  'teamspace_agent_access','connectors','ingest','background_lanes','derived_writes',
  'delegation','operation_separation','replay_delivery','grant_expiry',
  'org_references','scope_review',
] as const)

export type DepartmentIsolationCaseId = typeof DEPARTMENT_ISOLATION_CASE_IDS[number]
export type DepartmentIsolationCapability = typeof DEPARTMENT_ISOLATION_REQUIRED_CAPABILITIES[number]

export type DepartmentIsolationAssertionSelector = {
  suiteId: string
  testFile: string
  titleIncludes: string
}

export type DepartmentIsolationSuite = {
  id: string
  packageDir: 'packages/core'|'packages/api'|'apps/app-web'|'apps/api'
  integration: boolean
  testFiles: readonly string[]
  processIsolation?: 'file'
}

export const DEPARTMENT_ISOLATION_SUITES: readonly DepartmentIsolationSuite[] = Object.freeze([
  {id:'kernel',packageDir:'packages/core',integration:false,testFiles:[
    'src/security/__tests__/access-ceiling.test.ts','src/security/__tests__/derived-scope.test.ts',
    'src/security/__tests__/source-evidence.test.ts','src/security/__tests__/context-scope.test.ts',
    'src/consolidation/__tests__/department-isolation.test.ts','src/consolidation/__tests__/consolidation.test.ts',
    'src/consolidation/__tests__/bi-temporal-filter.test.ts']},
  {id:'derived-store',packageDir:'packages/api',integration:true,testFiles:[
    'src/db/__tests__/derived-scope-store.integration.test.ts','src/db/__tests__/reflection-evidence.integration.test.ts',
    'src/db/__tests__/reader-source-evidence.integration.test.ts']},
  {id:'operation-stores',packageDir:'packages/api',integration:true,testFiles:[
    'src/db/__tests__/entity-mutation-scope.integration.test.ts','src/db/__tests__/file-mutation-scope.integration.test.ts',
    'src/db/__tests__/execution-read-ceiling.integration.test.ts','src/db/__tests__/external-principal-scope.test.ts']},
  {id:'workflow-authority',packageDir:'packages/api',integration:true,testFiles:[
    'src/context-scope/__tests__/workflow-authority.integration.test.ts',
    'src/context-scope/__tests__/workflow-input-evidence.integration.test.ts',
    'src/context-scope/__tests__/caller-evidence.integration.test.ts']},
  {id:'entrypoints',packageDir:'packages/api',integration:false,testFiles:[
    'src/context-scope/__tests__/path-security-matrix.test.ts','src/context-scope/__tests__/authority-lease.test.ts',
    'src/context-scope/__tests__/connector-exposure.test.ts','src/context-scope/__tests__/delivery-authority.test.ts',
    'src/context-scope/__tests__/delivery-replay.test.ts','src/inter-assistant/__tests__/delegation-scope.test.ts',
    'src/inter-assistant/__tests__/executor.test.ts','src/inter-assistant/__tests__/deliver.test.ts',
    'src/workflow/__tests__/channel-delivery.test.ts','src/routes/__tests__/proactive-compaction.test.ts']},
  {id:'access-policy',packageDir:'packages/api',integration:false,testFiles:[
    'src/workspace-access/__tests__/policy.test.ts','src/workspace-access/__tests__/tools.test.ts',
    'src/workspace-access/__tests__/readiness.test.ts','src/context-scope/__tests__/context-readiness.test.ts']},
  {id:'access-store',packageDir:'packages/api',integration:true,testFiles:[
    'src/workspace-access/__tests__/read-grants.integration.test.ts','src/workspace-access/__tests__/service.integration.test.ts',
    'src/workspace-access/__tests__/command-review.integration.test.ts','src/workspace-access/__tests__/history.integration.test.ts']},
  {id:'organization',packageDir:'packages/api',integration:true,testFiles:[
    'src/workspace-access/__tests__/org-chart.integration.test.ts',
    'src/workspace-access/__tests__/organization-command-review.integration.test.ts']},
  {id:'review-lifecycle',packageDir:'packages/api',integration:true,testFiles:[
    'src/workspace-access/__tests__/scope-review.integration.test.ts',
    'src/context-scope/__tests__/department-isolation.integration.test.ts']},
  {id:'strict-intake',packageDir:'packages/api',integration:false,testFiles:[
    'src/ingest/__tests__/programmatic-capture.test.ts','src/ingest/__tests__/room-ingest.test.ts']},
  {id:'ui',packageDir:'apps/app-web',integration:false,testFiles:[
    'src/components/workspace-access/__tests__/workspace-access.test.tsx',
    'src/components/workspace-access/__tests__/scope-review.test.tsx',
    'src/components/organization/__tests__/organization-chart.test.tsx',
    'src/components/context/__tests__/department-editors.test.tsx']},
  {id:'compatibility',packageDir:'packages/api',integration:false,processIsolation:'file',testFiles:[
    'src/routes/__tests__/channels.test.ts','src/routes/__tests__/computer.test.ts',
    'src/routes/__tests__/home-apps.test.ts']},
  {id:'migration-lifecycle',packageDir:'apps/api',integration:false,testFiles:[
    'src/__tests__/context-scope-security-matrix.test.ts']},
])

const selector = (suiteId: string, testFile: string, titleIncludes: string): DepartmentIsolationAssertionSelector =>
  ({suiteId,testFile,titleIncludes})

export const DEPARTMENT_ISOLATION_CASES: ReadonlyArray<{
  id: DepartmentIsolationCaseId
  assertions: readonly DepartmentIsolationAssertionSelector[]
}> = Object.freeze([
  {id:'A01',assertions:[
    selector('entrypoints','src/context-scope/__tests__/path-security-matrix.test.ts','projects Team and Project scope before every retrieval family expands'),
    selector('operation-stores','src/db/__tests__/file-mutation-scope.integration.test.ts','checks current-member file authority'),
  ]},
  {id:'A02',assertions:[
    selector('kernel','src/consolidation/__tests__/department-isolation.test.ts','A02 compatible departmental Light'),
    selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A02 executes real departmental Light and REM writers'),
    selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A02 stores department SOUL and domains'),
  ]},
  {id:'A03',assertions:[
    selector('kernel','src/consolidation/__tests__/department-isolation.test.ts','A03 Light never merges'),
    selector('kernel','src/consolidation/__tests__/department-isolation.test.ts','A03 routine REM uses separate model calls'),
  ]},
  {id:'A04',assertions:[
    selector('kernel','src/consolidation/__tests__/department-isolation.test.ts','A04 includes uncited examples'),
    selector('kernel','src/consolidation/__tests__/department-isolation.test.ts','A04 withholds missing labels'),
    selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A02/A04 persists the full floor'),
  ]},
  {id:'A05',assertions:[
    selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A05 rejects stale source versions'),
    selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A05 serializes source narrowing'),
    selector('operation-stores','src/db/__tests__/entity-mutation-scope.integration.test.ts','preserves confidentiality in ordinary updates and supersession'),
  ]},
  {id:'A06',assertions:[
    selector('workflow-authority','src/context-scope/__tests__/workflow-authority.integration.test.ts','refuses contraction and actor substitution'),
    selector('entrypoints','src/inter-assistant/__tests__/executor.test.ts','keeps the caller actor and inherited ceiling'),
  ]},
  {id:'A07',assertions:[
    selector('entrypoints','src/context-scope/__tests__/delivery-authority.test.ts','rechecks an exact owner-approved binding'),
    selector('entrypoints','src/inter-assistant/__tests__/delegation-scope.test.ts','keeps inherited Team evidence inside the exact approved group binding'),
    selector('entrypoints','src/workflow/__tests__/channel-delivery.test.ts','refuses an unverified audience'),
  ]},
  {id:'A08',assertions:[
    selector('entrypoints','src/context-scope/__tests__/delivery-replay.test.ts','refuses a contraction before tool'),
    selector('entrypoints','src/context-scope/__tests__/delivery-replay.test.ts','withholds a possibly executed tool result'),
    selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A08 holds all descendants'),
  ]},
  {id:'A09',assertions:[
    selector('access-store','src/workspace-access/__tests__/read-grants.integration.test.ts','allows canonical entity reads under a read grant'),
    selector('access-store','src/workspace-access/__tests__/read-grants.integration.test.ts','retains ordinary mutation rights'),
    selector('operation-stores','src/db/__tests__/execution-read-ceiling.integration.test.ts','mutation'),
  ]},
  {id:'A10',assertions:[
    selector('access-policy','src/workspace-access/__tests__/policy.test.ts','blocks distribution of an expanded Team package'),
    selector('access-policy','src/workspace-access/__tests__/policy.test.ts','forbids self approval'),
    selector('access-store','src/workspace-access/__tests__/service.integration.test.ts','prevents membership escalation through expanded packages'),
  ]},
  {id:'A11',assertions:[
    selector('access-store','src/workspace-access/__tests__/command-review.integration.test.ts','serializes concurrent application to one effect and audit'),
    selector('access-store','src/workspace-access/__tests__/service.integration.test.ts','creates one review card and atomically settles request'),
    selector('access-store','src/workspace-access/__tests__/read-grants.integration.test.ts','revocation'),
  ]},
  {id:'A12',assertions:[
    selector('migration-lifecycle','src/__tests__/context-scope-security-matrix.test.ts','fresh, 591 and predecessor migration lifecycles'),
    selector('organization','src/workspace-access/__tests__/org-chart.integration.test.ts','A12 rejects unit and reporting cycles'),
    selector('organization','src/workspace-access/__tests__/org-chart.integration.test.ts','A12 rejects same-workspace violations'),
  ]},
  {id:'A13',assertions:[
    selector('organization','src/workspace-access/__tests__/org-chart.integration.test.ts','A13 moves never change membership'),
    selector('organization','src/workspace-access/__tests__/org-chart.integration.test.ts','initializes only the explicitly selected primary assignment'),
  ]},
  {id:'A14',assertions:[
    selector('organization','src/workspace-access/__tests__/org-chart.integration.test.ts','A14 projects visible descendants'),
    selector('ui','src/components/organization/__tests__/organization-chart.test.tsx','keyboard-operable outline'),
    selector('ui','src/components/organization/__tests__/organization-chart.test.tsx','searches only projected data'),
  ]},
  {id:'A15',assertions:[
    selector('review-lifecycle','src/workspace-access/__tests__/scope-review.integration.test.ts','resumes bounded pages and does not replay'),
    selector('review-lifecycle','src/workspace-access/__tests__/scope-review.integration.test.ts','holds known descendants'),
    selector('review-lifecycle','src/workspace-access/__tests__/scope-review.integration.test.ts','inspects every frozen cache/index impact'),
  ]},
  {id:'A16',assertions:[
    selector('strict-intake','src/ingest/__tests__/programmatic-capture.test.ts','persists a strict legacy binding on hold'),
    selector('strict-intake','src/ingest/__tests__/room-ingest.test.ts','holds a strict legacy room binding'),
    selector('review-lifecycle','src/context-scope/__tests__/department-isolation.integration.test.ts','permits only a current fully reviewed fixture'),
  ]},
  {id:'A17',assertions:[
    selector('access-policy','src/workspace-access/__tests__/tools.test.ts','same'),
    selector('ui','src/components/workspace-access/__tests__/workspace-access.test.tsx','complete controls in all four locales'),
    selector('ui','src/components/organization/__tests__/organization-chart.test.tsx','complete translated controls in all four locales'),
    selector('ui','src/components/context/__tests__/department-editors.test.tsx','confirmation'),
  ]},
  {id:'A18',assertions:[
    selector('compatibility','src/routes/__tests__/channels.test.ts','updates a channel and returns the new row'),
    selector('compatibility','src/routes/__tests__/computer.test.ts','updates clearance, enablement'),
    selector('compatibility','src/routes/__tests__/home-apps.test.ts','serves a bundle file for a valid token'),
  ]},
])

export const DEPARTMENT_ISOLATION_BOUNDARIES = Object.freeze([
  {id:'brain-retrieval',family:'original_sources',reader:'packages/api/src/db/{retrieval-store,knowledge-store,memories}.ts',writer:'packages/api/src/db/{memories,knowledge-store}.ts',evidenceField:'ScopeEvidence.sources',operationCheck:'buildAccessPredicate + current operation ceiling',deliverySink:null,capabilities:['row_store_coverage','turn_entry_points'],cases:['A01','A18'],sourcePaths:['packages/api/src/db/access-predicate.ts','packages/core/src/security/source-evidence.ts'],tests:[selector('entrypoints','src/context-scope/__tests__/path-security-matrix.test.ts','projects Team and Project scope')]},
  {id:'derived-memory',family:'derived_outputs',reader:'packages/api/src/db/memory-store.ts',writer:'packages/api/src/db/derived-scope-store.ts',evidenceField:'scope_derivations source version set',operationCheck:'canonical derived write transaction',deliverySink:null,capabilities:['write_inheritance','derived_writes'],cases:['A02','A04','A05'],sourcePaths:['packages/api/src/db/derived-scope-store.ts','packages/core/src/security/derived-scope.ts'],tests:[selector('derived-store','src/db/__tests__/derived-scope-store.integration.test.ts','A02/A04 persists the full floor')]},
  {id:'consolidation',family:'derived_outputs',reader:'packages/core/src/consolidation/phases.ts',writer:'packages/core/src/consolidation/worker.ts',evidenceField:'complete input ScopeEvidence',operationCheck:'exact-envelope partition and source revalidation',deliverySink:null,capabilities:['background_lanes','derived_writes'],cases:['A02','A03','A04','A05'],sourcePaths:['packages/core/src/consolidation/phases.ts','packages/core/src/consolidation/worker.ts'],tests:[selector('kernel','src/consolidation/__tests__/department-isolation.test.ts','A03 routine REM')]},
  {id:'entity-crm',family:'original_sources',reader:'packages/api/src/db/crm.ts',writer:'packages/api/src/db/crm-r2.ts',evidenceField:'entity source envelope and operation receipt',operationCheck:'read/mutation predicate under current member',deliverySink:null,capabilities:['row_store_coverage','operation_separation','grant_expiry'],cases:['A01','A05','A09'],sourcePaths:['packages/api/src/db/crm.ts','packages/api/src/db/crm-r2.ts'],tests:[selector('operation-stores','src/db/__tests__/entity-mutation-scope.integration.test.ts','preserves confidentiality')]},
  {id:'files-office',family:'original_sources',reader:'packages/api/src/db/workspace-files.ts',writer:'packages/api/src/structured-documents/service.ts',evidenceField:'canonical root/source manifest',operationCheck:'file mutation ceiling and parent scope',deliverySink:'authenticated file/page responses',capabilities:['row_store_coverage','operation_separation'],cases:['A01','A09','A18'],sourcePaths:['packages/api/src/db/workspace-files.ts','packages/api/src/structured-documents/service.ts'],tests:[selector('operation-stores','src/db/__tests__/file-mutation-scope.integration.test.ts','checks current-member file authority')]},
  {id:'sessions-teamspaces',family:'input_bindings',reader:'packages/api/src/db/sessions.ts',writer:'packages/api/src/db/context-scope-store.ts',evidenceField:'locked session Team/Project binding',operationCheck:'current member/assistant/session intersection',deliverySink:'interactive stream',capabilities:['session_isolation','teamspace_agent_access'],cases:['A01','A07','A08'],sourcePaths:['packages/api/src/db/sessions.ts','packages/api/src/db/context-scope-store.ts'],tests:[selector('entrypoints','src/context-scope/__tests__/path-security-matrix.test.ts','binds and locks both context axes')]},
  {id:'connectors',family:'input_bindings',reader:'packages/api/src/context-scope/connector-exposure.ts',writer:'packages/api/src/db/connector-grant-store.ts',evidenceField:'connector root and caller evidence',operationCheck:'provider-root capability and mutation ceiling',deliverySink:'connector adapter',capabilities:['connectors','operation_separation'],cases:['A01','A09','A18'],sourcePaths:['packages/api/src/context-scope/connector-exposure.ts','packages/api/src/db/connector-grant-store.ts'],tests:[selector('entrypoints','src/context-scope/__tests__/connector-exposure.test.ts','read')]},
  {id:'strict-ingest',family:'input_bindings',reader:'packages/api/src/ingest/{programmatic-capture,room-ingest}.ts',writer:'packages/api/src/db/pending-ingest-batches-store.ts',evidenceField:'scope_binding_origin + held envelope',operationCheck:'explicit/reviewed binding in strict mode',deliverySink:null,capabilities:['ingest','scope_review'],cases:['A16','A18'],sourcePaths:['packages/api/src/ingest/programmatic-capture.ts','packages/api/src/ingest/room-ingest.ts'],tests:[selector('strict-intake','src/ingest/__tests__/programmatic-capture.test.ts','persists a strict legacy binding on hold')]},
  {id:'workflow-goal-schedule',family:'background_jobs',reader:'packages/api/src/context-scope/workflow-authority.ts',writer:'packages/api/src/db/{workflow-store,goals,job-store}.ts',evidenceField:'authoring authority and input evidence',operationCheck:'sticky authority lease per advance',deliverySink:'workflow/schedule/goal delivery ports',capabilities:['background_lanes','delegation','replay_delivery','grant_expiry'],cases:['A06','A07','A08','A18'],sourcePaths:['packages/api/src/context-scope/workflow-authority.ts','packages/api/src/context-scope/workflow-input-evidence.ts'],tests:[selector('workflow-authority','src/context-scope/__tests__/workflow-authority.integration.test.ts','refuses contraction and actor substitution')]},
  {id:'delegation',family:'delegation',reader:'packages/api/src/inter-assistant/executor.ts',writer:'packages/api/src/context-scope/caller-evidence.ts',evidenceField:'authenticated caller ceiling and source evidence',operationCheck:'caller/current/callee intersection',deliverySink:'inter-assistant return or bound target',capabilities:['delegation','replay_delivery'],cases:['A06','A07','A08'],sourcePaths:['packages/api/src/inter-assistant/executor.ts','packages/api/src/context-scope/caller-evidence.ts'],tests:[selector('entrypoints','src/inter-assistant/__tests__/executor.test.ts','keeps the caller actor and inherited ceiling')]},
  {id:'replay-compaction',family:'replay',reader:'packages/api/src/routes/session-resume-replay.ts',writer:'packages/api/src/routes/proactive-compaction.ts',evidenceField:'serialized starting ceiling + high-water evidence',operationCheck:'sticky live authority lease',deliverySink:'resumed interactive output',capabilities:['replay_delivery','grant_expiry'],cases:['A08','A18'],sourcePaths:['packages/api/src/routes/session-resume-replay.ts','packages/api/src/routes/proactive-compaction.ts'],tests:[selector('entrypoints','src/context-scope/__tests__/delivery-replay.test.ts','refuses a contraction before tool')]},
  {id:'recipient-delivery',family:'delivery',reader:'packages/api/src/context-scope/delivery-authority.ts',writer:'packages/api/src/db/channel-integrations.ts',evidenceField:'final high-water evidence and exact destination binding',operationCheck:'current recipient authority before every token/write/send',deliverySink:'room/channel/relay adapter',capabilities:['replay_delivery','grant_expiry'],cases:['A04','A07','A08'],sourcePaths:['packages/api/src/context-scope/delivery-authority.ts','packages/api/src/workflow/channel-delivery.ts'],tests:[selector('entrypoints','src/context-scope/__tests__/delivery-authority.test.ts','rechecks an exact owner-approved binding')]},
  {id:'operation-ceilings',family:'operation_ceiling',reader:'packages/api/src/db/operation-ceiling.ts',writer:'packages/api/src/db/agent-access-context.ts',evidenceField:'independent read/mutation ceilings',operationCheck:'live grant and ordinary-membership intersection',deliverySink:null,capabilities:['operation_separation','grant_expiry'],cases:['A08','A09'],sourcePaths:['packages/api/src/db/operation-ceiling.ts','packages/api/src/db/agent-access-context.ts'],tests:[selector('operation-stores','src/db/__tests__/execution-read-ceiling.integration.test.ts','mutation')]},
  {id:'access-administration',family:'operation_ceiling',reader:'packages/api/src/workspace-access/service.ts',writer:'packages/api/src/workspace-access/command-review.ts',evidenceField:'immutable saved intent + policy revision',operationCheck:'transactional current actor/beneficiary/approver authority',deliverySink:'filtered approval/history projection',capabilities:['grant_expiry','operation_separation'],cases:['A09','A10','A11','A17'],sourcePaths:['packages/api/src/workspace-access/service.ts','packages/api/src/workspace-access/command-review.ts'],tests:[selector('access-store','src/workspace-access/__tests__/command-review.integration.test.ts','serializes concurrent application')]},
  {id:'organization',family:'organization',reader:'packages/api/src/workspace-access/org-chart.ts',writer:'packages/api/src/db/org-chart-store.ts',evidenceField:'directory projection and organization revision',operationCheck:'same-workspace/cycle/current admin transaction',deliverySink:'filtered tree/detail/search',capabilities:['org_references'],cases:['A12','A13','A14','A17'],sourcePaths:['packages/api/src/workspace-access/org-chart.ts','packages/api/src/db/org-chart-store.ts'],tests:[selector('organization','src/workspace-access/__tests__/org-chart.integration.test.ts','A12 rejects unit and reporting cycles')]},
  {id:'scope-review',family:'review',reader:'packages/api/src/workspace-access/scope-review-registry.ts',writer:'packages/api/src/workspace-access/scope-review.ts',evidenceField:'versioned content/scope/impact snapshot',operationCheck:'current complete inventory and source locks',deliverySink:'admin-only bounded review projection',capabilities:['scope_review','derived_writes'],cases:['A15','A16','A17'],sourcePaths:['packages/api/src/workspace-access/scope-review-registry.ts','packages/api/src/workspace-access/scope-review.ts'],tests:[selector('review-lifecycle','src/workspace-access/__tests__/scope-review.integration.test.ts','inspects and holds every frozen immutable evidence family')]},
  {id:'strict-activation',family:'activation',reader:'packages/api/src/context-scope/context-readiness.ts',writer:'packages/api/src/workspace-access/service.ts',evidenceField:'manifest capabilities + live schema/current inventory',operationCheck:'saved owner/admin strict activation command',deliverySink:'access/readiness projection',capabilities:['row_store_coverage','turn_entry_points','write_inheritance','session_isolation','teamspace_agent_access','connectors','ingest','background_lanes','derived_writes','delegation','operation_separation','replay_delivery','grant_expiry','org_references','scope_review'],cases:['A11','A15','A16','A17'],sourcePaths:['packages/api/src/context-scope/context-readiness.ts','packages/api/src/workspace-access/readiness.ts'],tests:[selector('review-lifecycle','src/context-scope/__tests__/department-isolation.integration.test.ts','permits only a current fully reviewed fixture')]},
  {id:'compatibility',family:'compatibility',reader:'packages/api/src/routes/{channels,computer,home-apps}.ts',writer:'existing canonical route stores',evidenceField:'existing caller/workspace authority',operationCheck:'normal route topology and typed validation',deliverySink:'existing API responses',capabilities:['turn_entry_points'],cases:['A18'],sourcePaths:['packages/api/src/routes/channels.ts','packages/api/src/routes/computer.ts','packages/api/src/routes/home-apps.ts'],tests:[selector('compatibility','src/routes/__tests__/channels.test.ts','updates a channel and returns the new row'),selector('compatibility','src/routes/__tests__/computer.test.ts','updates clearance, enablement'),selector('compatibility','src/routes/__tests__/home-apps.test.ts','serves a bundle file for a valid token')]},
] as const)

export function departmentIsolationManifestCoverage(): {
  complete: boolean
  missingCases: DepartmentIsolationCaseId[]
  missingCapabilities: DepartmentIsolationCapability[]
} {
  const cases = new Set(DEPARTMENT_ISOLATION_BOUNDARIES.flatMap(entry => entry.cases))
  const capabilities = new Set(DEPARTMENT_ISOLATION_BOUNDARIES.flatMap(entry => entry.capabilities))
  const missingCases = DEPARTMENT_ISOLATION_CASE_IDS.filter(id => !cases.has(id))
  const missingCapabilities = DEPARTMENT_ISOLATION_REQUIRED_CAPABILITIES.filter(id => !capabilities.has(id))
  return {complete: missingCases.length === 0 && missingCapabilities.length === 0,missingCases,missingCapabilities}
}
