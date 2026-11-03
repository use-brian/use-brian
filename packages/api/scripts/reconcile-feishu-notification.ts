/** Operator evidence only; never guesses whether a provider send happened. [COMP:channels/feishu-notifications] */
import {readFile} from 'node:fs/promises'
import pg from 'pg'
import {z} from 'zod'
const schema=z.object({clientId:z.string().uuid(),id:z.string().uuid(),status:z.enum(['delivered','not_sent']),messageId:z.string().regex(/^om_[A-Za-z0-9_-]+$/).optional(),evidence:z.string().min(10).max(1000)}).strict().refine(v=>v.status==='delivered'?Boolean(v.messageId):!v.messageId)
const file=process.argv[2];if(!file||!process.env.DATABASE_URL)throw new Error('Usage: DATABASE_URL=... tsx scripts/reconcile-feishu-notification.ts verified-outcome.json')
const input=schema.parse(JSON.parse(await readFile(file,'utf8'))),pool=new pg.Pool({connectionString:process.env.DATABASE_URL})
try{
 const result=await pool.query(`UPDATE feishu_notification_receipts SET status=$3,message_id=$4,error_code=NULL,reconciliation_evidence=$5,reconciled_at=now(),updated_at=now()
 WHERE client_id=$1 AND id=$2 AND (status IN('failed','uncertain') OR status='sending' AND updated_at<now()-interval '5 minutes') RETURNING id,status`,[input.clientId,input.id,input.status,input.messageId??null,input.evidence])
 if(result.rowCount!==1)throw new Error('Receipt unavailable or not eligible for reconciliation')
 console.log(JSON.stringify(result.rows[0]))
}finally{await pool.end()}
