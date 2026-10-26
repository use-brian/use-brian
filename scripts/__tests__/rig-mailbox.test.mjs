import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {createRigMailbox,MAILBOX_LIMITS} from '../rig-mailbox.mjs'
const require=createRequire(new URL('../../packages/api/package.json',import.meta.url)),{createTransport}=require('nodemailer')
async function fixture(fn){const directory=await mkdtemp(join(tmpdir(),'rig-mail-'));const mailbox=await createRigMailbox({directory});const transport=createTransport({host:'127.0.0.1',port:mailbox.port,secure:false,auth:{user:'capture@fixture.example',pass:'fixture-only'},connectionTimeout:1000,socketTimeout:2000});try{await fn({directory,mailbox,transport})}finally{transport.close();await mailbox.close();await rm(directory,{recursive:true,force:true})}}
test('[COMP:platform/local-rig] actual SMTP captures genuine generated mail unchanged and private',async()=>fixture(async({directory,transport})=>{
 const token='synthetic-one-use-value',link='http://localhost:3003/login/verify?token='+token
 await transport.sendMail({from:'auth@fixture.example',to:'customer@portal.example',subject:'Sign in',text:'Your code is 123456\n'+link})
 const files=await readdir(directory);assert.equal(files.length,1);const path=join(directory,files[0]);assert.match(await readFile(path,'utf8'),/synthetic-one-use-value/);assert.equal((await stat(path)).mode&0o777,0o600)
}))
test('SMTP refuses non-fictional recipients, absent credentials and oversized mail',async()=>fixture(async({directory,mailbox,transport})=>{
 await assert.rejects(transport.sendMail({from:'auth@fixture.example',to:'person@example.com',text:'no external mail'}),/550/)
 const unauthenticated=createTransport({host:'127.0.0.1',port:mailbox.port,secure:false,connectionTimeout:1000,socketTimeout:2000})
 try{await assert.rejects(unauthenticated.sendMail({from:'auth@fixture.example',to:'person@portal.example',text:'no identity bypass'}),/530/)}finally{unauthenticated.close()}
 await assert.rejects(transport.sendMail({from:'auth@fixture.example',to:'person@portal.example',text:'x'.repeat(MAILBOX_LIMITS.messageBytes+10000)}))
 assert.equal((await readdir(directory)).length,0)
}))
test('SMTP bounds total saved messages and does not overwrite prior mail',async()=>fixture(async({directory,transport})=>{
 for(let i=0;i<MAILBOX_LIMITS.messages;i++)await writeFile(join(directory,'preserved-'+i+'.eml'),'prior',{mode:0o600})
 // Startup inventory, rather than a racy per-connection scan, accounts for retained mail.
 const extra=await createRigMailbox({directory}),limited=createTransport({host:'127.0.0.1',port:extra.port,secure:false,auth:{user:'capture@fixture.example',pass:'fixture-only'},socketTimeout:2000})
 try{await assert.rejects(limited.sendMail({from:'auth@fixture.example',to:'person@portal.example',text:'held'}),/452/)}finally{limited.close();await extra.close()}
 assert.equal((await readdir(directory)).length,MAILBOX_LIMITS.messages)
}))
