/** Current Office resource bytes and bounded display authority. [COMP:api/office-resources] */
import {createHash} from 'node:crypto'
import type {FilesApi} from '@use-brian/core'
import type {createOfficeTemplateStore} from '../db/office-templates.js'
import type {getWorkspaceFileReadProjection} from '../db/workspace-files.js'
import type {getWorkspaceMembershipWithClearanceSystem} from '../db/workspace-store.js'
import {workspaceFileReadRevision} from '../files/files-api.js'
import {bindOfficeFile} from './file-binding.js'

type Resource = NonNullable<Awaited<ReturnType<ReturnType<typeof createOfficeTemplateStore>['getResource']>>>
const revision = (resource:Resource) => JSON.stringify(resource)

export function createOfficeResourceReader(deps:{
  filesApi:Pick<FilesApi,'readBytes'>
  getResource:ReturnType<typeof createOfficeTemplateStore>['getResource']
  membership:typeof getWorkspaceMembershipWithClearanceSystem
  readProjection:typeof getWorkspaceFileReadProjection
}) {
  return async(userId:string,workspaceId:string,resourceId:string) => {
    const [resource,member]=await Promise.all([deps.getResource(userId,resourceId),deps.membership(userId,workspaceId)])
    if(!resource?.fileId||resource.workspaceId!==workspaceId||!member)return null
    const resourceRevision=revision(resource)
    const clearance=member.role==='owner'||member.role==='admin'?'confidential':member.clearance
    const context={workspaceId,userId,assistantKind:'standard' as const,clearance}
    const read=await deps.filesApi.readBytes(context,resource.fileId)
    if(!read.ok||read.value.file.workspaceId!==workspaceId||read.value.file.id!==resource.fileId)return null
    const fileRevision=workspaceFileReadRevision(read.value.file)
    const bytesHash=createHash('sha256').update(read.value.bytes).digest('hex')
    if(bytesHash!==resource.hash)return null
    const started=performance.now()
    const [current,projection]=await Promise.all([
      deps.getResource(userId,resourceId),
      deps.readProjection({...context,assistantId:userId},resource.fileId),
    ])
    const validForMs=Math.floor(Math.min(30_000,projection?.validForMs??0)-(performance.now()-started))
    if(!current||revision(current)!==resourceRevision||!projection||
      workspaceFileReadRevision(projection.file)!==fileRevision||!Number.isFinite(validForMs)||validForMs<=0)return null
    return {bytes:read.value.bytes,mime:current.mime,hash:current.hash,validForMs,binding:bindOfficeFile(read.value.file,read.value.bytes)}
  }
}
