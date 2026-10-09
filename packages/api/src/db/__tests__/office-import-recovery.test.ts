import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createOfficeGenerationStore } from '../office-generation.js'
import type { OfficeDbQuery } from '../office-artifacts.js'
let pg:PGlite
const query:OfficeDbQuery=async<T>(_actor:string,sql:string,params:unknown[])=>pg.query<T>(sql,params)
const jobs=createOfficeGenerationStore(query)
beforeAll(async()=>{pg=new PGlite();await pg.exec(`
CREATE TABLE office_artifacts(id uuid PRIMARY KEY, lifecycle_state text DEFAULT 'active',head_version int DEFAULT 0);
CREATE TABLE office_templates(id uuid PRIMARY KEY,draft_artifact_id uuid,lifecycle_state text DEFAULT 'draft');
CREATE TABLE office_collab_documents(artifact_id uuid PRIMARY KEY,seq int DEFAULT 1);
CREATE TABLE office_generation_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,artifact_id uuid,initiated_by_user_id uuid,assistant_id uuid,job_kind text,status text DEFAULT 'queued',stage text DEFAULT 'queued',brief jsonb,authority_projection jsonb,template_version_id uuid,base_artifact_version int DEFAULT 0,checkpoint jsonb DEFAULT '{}',checkpoint_version int DEFAULT 0,lease_token uuid,lease_expires_at timestamptz,cancel_requested_at timestamptz,error_code text,error_detail text,created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT now(),next_attempt_at timestamptz DEFAULT now(),idempotency_key text,UNIQUE(workspace_id,initiated_by_user_id,idempotency_key));
CREATE TABLE office_generation_steering(id uuid DEFAULT gen_random_uuid(),job_id uuid,workspace_id uuid,sender_user_id uuid,instruction text);
CREATE TABLE office_generation_events(id uuid DEFAULT gen_random_uuid(),job_id uuid,workspace_id uuid,seq bigint,code text,params jsonb,actor_type text,actor_user_id uuid,actor_assistant_id uuid,safe_narration text,created_at timestamptz DEFAULT now());
`)},30000)
afterAll(async()=>{await pg?.close()})
async function fixture(){const userId=randomUUID(),workspaceId=randomUUID(),artifactId=randomUUID(),templateId=randomUUID();await pg.query('INSERT INTO office_artifacts(id) VALUES($1)',[artifactId]);await pg.query('INSERT INTO office_templates(id,draft_artifact_id) VALUES($1,$2)',[templateId,artifactId]);await pg.query('INSERT INTO office_collab_documents(artifact_id) VALUES($1)',[artifactId]);const job=await jobs.create({userId,workspaceId,artifactId,assistantId:null,jobKind:'template_compile',brief:{templateId,source:{kind:'upload',fileId:randomUUID()}},authorityProjection:{},idempotencyKey:randomUUID()});await pg.query("UPDATE office_generation_jobs SET status='failed' WHERE id=$1",[job.id]);return{userId,workspaceId,artifactId,failedJobId:job.id}}
describe('[COMP:api/office-generation] retry and missing-fact SQL',()=>{
 it('converges overlapping retries onto one job and rejects a conflicting replacement',async()=>{const f=await fixture();const [a,b]=await Promise.all([jobs.retryTemplateImport(f),jobs.retryTemplateImport(f)]);expect(a?.id).toBeTruthy();expect(a?.id).toBe(b?.id);expect(await jobs.retryTemplateImport({...f,fileId:randomUUID()})).toBeNull();expect((await pg.query('SELECT id FROM office_generation_jobs WHERE artifact_id=$1',[f.artifactId])).rows).toHaveLength(2)})
 it('refuses retry after the draft has been edited',async()=>{const f=await fixture();await pg.query('UPDATE office_collab_documents SET seq=2 WHERE artifact_id=$1',[f.artifactId]);expect(await jobs.retryTemplateImport(f)).toBeNull()})
 it('persists an answer and requeues a missing-fact job, but rejects another actor',async()=>{const f=await fixture();await pg.query("UPDATE office_generation_jobs SET job_kind='create',status='needs_input',error_code='material_fact_missing',brief=brief || '{\"additionalContext\":\"Known facts\"}'::jsonb WHERE id=$1",[f.failedJobId]);await expect(jobs.steer({...f,userId:randomUUID(),jobId:f.failedJobId,instruction:'No access'})).rejects.toThrow();await jobs.steer({...f,jobId:f.failedJobId,instruction:'Payment terms confirmed: net 30'});expect(await jobs.get(f.userId,f.failedJobId)).toMatchObject({status:'queued',errorCode:null,brief:{additionalContext:'Known facts\nPayment terms confirmed: net 30'}});expect((await pg.query<{code:string}>('SELECT code FROM office_generation_events WHERE job_id=$1',[f.failedJobId])).rows.map(r=>r.code)).toEqual(['office.job.input_received'])})
})
