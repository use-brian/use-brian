/** [COMP:api/channel-recording] Genuine recording provenance for owned PG fixtures. */
import {randomUUID} from 'node:crypto'
import type {SessionContextAuthority} from '@use-brian/core'
import {expect} from 'vitest'
import {query,runWithAgentAccess} from '../../db/client.js'
import {createDbWorkspaceFilesStore} from '../../db/workspace-files-store.js'
import {createWorkspaceAuditStore} from '../../db/workspace-audit-store.js'
import {captureRecordingSegmentProvenance} from '../../db/recording-intake-admission.js'
import {resolveRecordingForFile} from '../../recordings/recording-for-file.js'
import {createTranscriptArtifactWriter} from '../../recordings/transcript-artifact.js'
import {createFilesApi} from '../../files/files-api.js'

/** Metadata setup belongs to the disposable fixture owner. Adoption, provenance
 * capture and transcript publication use the real supplied actor authority;
 * only blob storage is in memory. Private-owner inputs require a real personal
 * execution; the default shared input remains unchanged. Call once per title. */
export async function createRecordingTranscriptFixture(authority:SessionContextAuthority,title='Fictional indexed recording',options:{privateOwner?:boolean}={}){
 const {workspaceId:workspace,userId:owner}=authority.execution.security.access
 const mediaFileId=randomUUID(),store=createDbWorkspaceFilesStore()
 await query(`INSERT INTO workspace_files(id,workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,
  created_by_user_id,sensitivity,user_id,assistant_id,compartments,project_ids,metadata)
  VALUES($1,$2,$4,'/recordings','Fictional source.wav','audio/wav',3,
   'gs://fictional-index/source.wav',$3,'internal',$5,NULL,'{}','{}','{"noIndex":true}')`,
 [mediaFileId,workspace,owner,`/recordings/fictional-source-${mediaFileId}.wav`,options.privateOwner?owner:null])
 return runWithAgentAccess(authority.execution.security.access,async()=>{
  const media=await store.getById(authority.execution.security.access,mediaFileId);expect(media).not.toBeNull()
  const adopted=await resolveRecordingForFile(media!,owner);expect(adopted.status).toBe('ok')
  if(adopted.status!=='ok')throw new Error('The fictional recording parent was not admitted')
  const provenance=await captureRecordingSegmentProvenance({actorUserId:owner,access:authority.execution.security.access},workspace,adopted.recordingId)
  const blobs=new Map<string,Buffer>()
  const storage={writeBlob:async(key:string,bytes:Buffer)=>{blobs.set(key,bytes)},deleteBlob:async(key:string)=>{blobs.delete(key)}}
  const filesApi=createFilesApi({store,auditStore:createWorkspaceAuditStore(),
   resolver:{forWorkspace:async()=>({gcs:storage as never,bucket:'fictional-index',byo:true}),forUri:async()=>storage as never}})
  const transcript=await createTranscriptArtifactWriter({filesApi})({recordingId:adopted.recordingId,workspaceId:workspace,
   actingUserId:owner,assistantId:null,sensitivity:'internal',title,
   utterances:[{startMs:0,speaker:null,text:'Fictional shared recording transcript.'}]},provenance)
  expect(transcript).not.toBeNull()
  expect([...blobs.values()].some(bytes=>bytes.toString().includes('Fictional shared recording transcript.'))).toBe(true)
  const parents=(await query<{source_kind:string;source_id:string}>(`SELECT s.source_kind,s.source_id FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
   WHERE d.workspace_id=$1 AND d.resource_kind='workspace_file' AND d.resource_id=$2 ORDER BY s.source_kind`,
  [workspace,transcript!.fileId])).rows
  expect(parents).toEqual([{source_kind:'episode',source_id:adopted.recordingId},
   {source_kind:'recording',source_id:adopted.recordingId},{source_kind:'workspace_file',source_id:mediaFileId}])
  return{mediaFileId,transcriptFileId:transcript!.fileId,episodeId:adopted.recordingId,recordingId:adopted.recordingId}
 })
}
