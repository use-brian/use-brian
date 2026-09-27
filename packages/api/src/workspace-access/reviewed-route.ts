/** Compatibility requests must consume their exact saved command. [COMP:api/workspace-access] */
import type {Request} from 'express'
import {departmentCommandApplySchema} from './commands.js'
import {applyDepartmentCommand} from './command-review.js'
import {WorkspaceAccessError} from './policy.js'

export function departmentRouteReview(req:Pick<Request,'get'>) {
  const parsed=departmentCommandApplySchema.safeParse({type:'access.command.apply',reviewId:req.get('X-Brian-Access-Review-Id'),payloadHash:req.get('X-Brian-Access-Review-Hash')})
  if(!parsed.success)throw new WorkspaceAccessError('access_review_required',409)
  return parsed.data
}

export function executeReviewedDepartmentRoute(workspaceId:string,userId:string,command:unknown,proof:ReturnType<typeof departmentRouteReview>) {
  return applyDepartmentCommand(workspaceId,userId,proof,command)
}
