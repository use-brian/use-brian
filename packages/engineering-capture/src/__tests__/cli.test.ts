import {spawn} from 'node:child_process'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {afterEach,describe,it,expect} from 'vitest'
import {CaptureSpool} from '../spool.js'
import {CollectorConfigSchema} from '../setup.js'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
function run(args:string[],input=''){return new Promise<{code:number|null;out:string;err:string}>(done=>{const p=spawn(process.execPath,[resolve('dist/cli.js'),...args],{env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:'pipe'});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('close',code=>done({code,out,err}));p.stdin.end(input)})}
describe('[COMP:engineering-capture/collector] real hook process continuity',()=>{
 it('EH05/EH12/EH13 concurrent hook processes retain one stable event and neutral output without altering setup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'capture-cli-'));dirs.push(dir)
  const config=CollectorConfigSchema.parse({version:1,provider:'codex',endpoint:'http://127.0.0.1:1/api/brain/mcp',credentialEnv:'FIXTURE_CAPTURE_KEY',project:dir,stateRoot:join(dir,'spool')})
  const path=join(dir,'config.json'),text=JSON.stringify(config);writeFileSync(path,text,{mode:0o600})
  const input=JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'fixture-session',turn_id:'stable-turn',cwd:dir,prompt:'  exact 工程\n',system:'hidden',tool:'hidden'})
  const initial=new CaptureSpool(config);initial.close()
  const results=await Promise.all(Array.from({length:6},()=>run(['hook','--config',path,'--no-wake'],input)))
  for(const r of results){expect(r.code).toBe(0);expect(r.out).toBe('{}\n');expect(r.err).not.toContain('exact')}
  const spool=new CaptureSpool(config);expect(spool.status().counts).toMatchObject({pending:1});expect(spool.next()?.payload?.content).toBe('  exact 工程\n');spool.close()
  expect(readFileSync(path,'utf8')).toBe(text)
  const denied=await run(['hook','--config',path,'--no-wake'],JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'outside',cwd:tmpdir(),prompt:'not opted in'}));expect(denied.out).toBe('{}\n')
  const setup=await run(['setup','--config',path]);expect(setup.code).toBe(0);expect(readFileSync(path,'utf8')).toBe(text)
 })
 it('EH13 missing configuration never blocks the coding application or leaks hook content',async()=>{
  const r=await run(['hook'],JSON.stringify({prompt:'PRIVATE FIXTURE'}));expect(r).toMatchObject({code:0,out:'{}\n'});expect(r.err).not.toContain('PRIVATE')
 })
})
