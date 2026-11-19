/** One statement owns the live facts of a session lease. [COMP:api/authority-lease] */
import { z } from 'zod'
import {canonicalScopeGrant, intersectScopeGrants} from '@use-brian/agent-runtime/security/context-scope.js'
import { query } from '../db/client.js'
import {decodeDepartmentSnapshot} from './department-resolver.js'

const tier = z.enum(['public', 'internal', 'confidential'])
const grant = z.array(z.string()).nullable()
const credentialSchema = z.object({userId: z.string().uuid(), sessionId: z.string().uuid(),
  authVersion: z.number().int().nonnegative()}).strict()
const facts = z.object({
  session: z.object({
    id: z.string().uuid(), assistantId: z.string().uuid(), userId: z.string().uuid(),
    contextGroupId: z.string().uuid().nullable(), contextProjectId: z.string().uuid().nullable(),
    contextLockedAt: z.coerce.date().nullable(), channelType:z.string(),channelId:z.string(),appOrigin:z.string().nullable(),anchorKind:z.string(),anchorRef:z.string().nullable(),
    visibility: z.string(), mode: z.string().nullable(), effectiveClearance: tier.nullable(), contextCompartments: z.array(z.string()),
  }).strict().nullable(),
  assistant: z.object({
    id: z.string().uuid(), workspaceId: z.string().uuid().nullable(),
    kind: z.enum(['primary', 'standard', 'app']), clearance: tier, compartments: grant,
    defaultCompartments: z.array(z.string()), teamScopeMode: z.enum(['legacy', 'all', 'assigned']),
    defaultWorkspaceGroupId: z.string().uuid().nullable(), projectScopeMode: z.enum(['all', 'assigned']),
    defaultProjectId: z.string().uuid().nullable(),
  }).strict().nullable(),
  member: z.object({
    role: z.enum(['owner', 'admin', 'member']), clearance: tier,
    readCompartments: grant, mutationCompartments: grant, departmentReadV2: z.string().nullable(),
  }).strict().nullable(),
  scope: z.object({
    assignedTeams: z.array(z.object({readAll:z.boolean(),own:z.string(),grant:z.string().nullable()}).strict()),
    assignedProjects: z.array(z.string().uuid()),
    team: z.object({id:z.string().uuid(),name:z.string(),key:z.string(),compartmentKey:z.string(),
      status:z.enum(['active','archived']),readAll:z.boolean(),grants:z.array(z.string())}).strict().nullable(),
    project: z.object({id:z.string().uuid(),name:z.string(),status:z.enum(['active','archived']),shared:z.boolean()}).strict().nullable(),
  }).strict(),
  credentialCurrent: z.boolean(),
  department: z.unknown(),
  policy: z.unknown(),
}).strict()

export type SessionAuthorityFactsInput = {
  sessionId: string; assistantId: string; workspaceId: string; userId: string;
  credential?: { userId: string; sessionId: string; authVersion: number };
  /** Host kernel-owned original lease; only record-frame acquisitions use it. */
  turn?: Readonly<{token:string}>;
  includeDepartments?: boolean; includePolicy?: boolean;
}

export function sessionAuthorityFactsParameters(input:SessionAuthorityFactsInput) {
  const credential=input.credential===undefined?undefined:credentialSchema.parse(input.credential)
  return [input.workspaceId || null,input.userId,input.assistantId,input.sessionId,credential?.sessionId??null,
    credential?.authVersion??null,credential?.userId??null,input.includeDepartments??true,input.includePolicy??false]
}

export async function readSessionAuthorityFacts(input:SessionAuthorityFactsInput) {
  const result=await query<{facts:unknown}>('SELECT read_session_authority_facts($1,$2,$3,$4,$5,$6,$7,$8,$9) AS facts',sessionAuthorityFactsParameters(input))
  if(result.rows.length!==1)throw new Error('authority_unavailable')
  return decodeSessionAuthorityFacts(input,result.rows[0].facts)
}

export function decodeSessionAuthorityFacts(input:SessionAuthorityFactsInput,raw:unknown) {
  const parsed=facts.parse(raw)
  const department=parsed.department===null ? undefined : {workspaceId:input.workspaceId,userId:input.userId,
    assistantId:input.assistantId,loaded:decodeDepartmentSnapshot({workspaceId:input.workspaceId,userId:input.userId,
      assistantId:input.assistantId},parsed.department)}
  const {assistant,scope}=parsed
  const assigned=scope.assignedTeams.some(row=>row.readAll)?null:canonicalScopeGrant(scope.assignedTeams.flatMap(row=>row.grant?[row.own,row.grant]:[row.own]))
  const scopeFacts={
    assistant:assistant?{teamGrant:assistant.teamScopeMode==='all'?null:assistant.teamScopeMode==='legacy'
      ?canonicalScopeGrant(assistant.compartments):assigned===null?null:intersectScopeGrants(assigned,assistant.compartments),
      projectGrant:assistant.projectScopeMode==='assigned'?canonicalScopeGrant(scope.assignedProjects):null}:null,
    team:scope.team?{...scope.team,readBundle:scope.team.readAll?null:canonicalScopeGrant([scope.team.compartmentKey,...scope.team.grants])}:null,
    project:scope.project,
  }
  return {...parsed,department,scopeFacts}
}
