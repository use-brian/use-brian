/** Operator-only explicit setup. [COMP:channels/feishu-notifications] */
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
const config = z.object({ workspaceId:z.string().uuid(), assistantId:z.string().uuid(), integrationId:z.string().uuid(),
 appOrigin:z.string().url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&u.origin===v}), expiresAt:z.string().datetime().refine(v=>Date.parse(v)>Date.now()),
 recipients:z.array(z.object({key:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),openId:z.string().regex(/^ou_[A-Za-z0-9]+$/)}).strict()).min(1).max(1000),
 evidence:z.string().min(10).max(1000) }).strict()
const [file,tokenFile]=process.argv.slice(2)
if(!file||!tokenFile||!process.env.DATABASE_URL)throw new Error('Usage: DATABASE_URL=... tsx scripts/provision-feishu-notifications.ts verified-config.json new-private-token-file')
const input=config.parse(JSON.parse(await readFile(file,'utf8'))), pool=new pg.Pool({connectionString:process.env.DATABASE_URL})
const id=randomUUID(),token='bn_'+randomBytes(32).toString('base64url')
// Exclusive token file creation precedes the database write; never overwrite an existing secret.
await writeFile(tokenFile,token+'\n',{mode:0o600,flag:'wx'})
const client=await pool.connect()
try{
 await client.query('BEGIN')
 const valid=await client.query(`SELECT 1 FROM channel_integrations i JOIN channels c ON c.id=i.channel_id JOIN channel_assistants a ON a.channel_id=c.id
 WHERE i.id=$1 AND c.workspace_id=$2 AND a.assistant_id=$3 AND i.channel_type='feishu' AND i.status='active' AND c.status='active'`,[input.integrationId,input.workspaceId,input.assistantId])
 if(!valid.rowCount)throw new Error('Exact active workspace/assistant/Feishu integration not found')
 await client.query('INSERT INTO feishu_notification_clients(id,token_hash,workspace_id,assistant_id,integration_id,app_origin,expires_at,approval_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
 [id,createHash('sha256').update(token).digest('hex'),input.workspaceId,input.assistantId,input.integrationId,input.appOrigin,input.expiresAt,input.evidence])
 for(const recipient of input.recipients)await client.query('INSERT INTO feishu_notification_recipients(client_id,recipient_key,open_id) VALUES($1,$2,$3)',[id,recipient.key,recipient.openId])
 await client.query('COMMIT');console.log(JSON.stringify({clientId:id,recipients:input.recipients.length,tokenFile}))
}catch(e){await client.query('ROLLBACK');throw e}finally{client.release();await pool.end()}
