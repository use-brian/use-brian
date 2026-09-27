/** No-store, bounded Office SQL metadata transport. [COMP:api/office-routes] */
import type {Request,RequestHandler} from 'express'
import {readOfficeProjection,type OfficeMetadataReply} from '../db/office-read-projection.js'

export function officeMetadataRoute(read:(req:Request,userId:string)=>Promise<OfficeMetadataReply>):RequestHandler {
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store')
    const userId=(req as {userId?:string}).userId
    const reply=userId?await readOfficeProjection(userId,()=>read(req,userId)):{status:401,body:{error:'Unauthorized'}}
    if(reply.validForMs!==undefined){
      res.setHeader('X-Brian-Projection-Valid-For-Ms',String(reply.validForMs))
      res.append('Access-Control-Expose-Headers','X-Brian-Projection-Valid-For-Ms')
    }
    // res.json/send generate conditional ETags; protected projections cannot 304.
    res.status(reply.status??200).type('json').end(JSON.stringify(reply.body))
  }
}
