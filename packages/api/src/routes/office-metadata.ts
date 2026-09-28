/** No-store, bounded Office SQL metadata transport. [COMP:api/office-routes] */
import type {Request,RequestHandler} from 'express'
import type {Response} from 'express'
import {readOfficeProjection,type OfficeMetadataReply} from '../db/office-read-projection.js'

export async function sendOfficeMetadata(res:Response,userId:string|undefined,read:()=>Promise<OfficeMetadataReply>):Promise<void>{
    res.setHeader('Cache-Control','private, no-store')
    const reply=userId?await readOfficeProjection(userId,read):{status:401,body:{error:'Unauthorized'}}
    if(reply.validForMs!==undefined){
      res.setHeader('X-Brian-Projection-Valid-For-Ms',String(reply.validForMs))
      res.append('Access-Control-Expose-Headers','X-Brian-Projection-Valid-For-Ms')
    }
    // res.json/send generate conditional ETags; protected projections cannot 304.
    res.status(reply.status??200).type('json').end(JSON.stringify(reply.body))
}

export function officeMetadataRoute(read:(req:Request,userId:string)=>Promise<OfficeMetadataReply>):RequestHandler {
  return async(req,res)=>{
    const userId=(req as {userId?:string}).userId
    await sendOfficeMetadata(res,userId,()=>read(req,userId!))
  }
}
