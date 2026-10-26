/** Loopback-only synthetic SMTP delivery. [COMP:platform/local-rig] */
import net from 'node:net'
import {mkdir,readdir,lstat,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {pathToFileURL} from 'node:url'
export const MAILBOX_LIMITS=Object.freeze({messageBytes:262144,messages:100,connections:8})
const mailboxAddress=value=>/^<[^<>\s@]+@(?:[a-z0-9-]+\.)+example>$/i.test(value)
export async function createRigMailbox({directory,port=0,user='capture@fixture.example',password='fixture-only'}={}) {
 if(!directory||!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid local mailbox configuration')
 await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe mailbox directory')
 let acceptedMessages=(await readdir(directory)).filter(file=>file.endsWith('.eml')).length
 const clients=new Set()
 const server=net.createServer(socket=>{
  if(clients.size>=MAILBOX_LIMITS.connections){socket.end('421 Fixture mailbox connection limit\r\n');return}
  clients.add(socket);socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket))
  let buffer='',body='',data=false,authenticated=false,sender,recipients=[],authStep='',loginUser=''
  const reply=text=>socket.write(text+'\r\n'),reset=()=>{body='';data=false;sender=undefined;recipients=[]}
  reply('220 fixture.example ESMTP local capture')
  let queue=Promise.resolve()
  socket.on('data',chunk=>{buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)+Buffer.byteLength(body)>MAILBOX_LIMITS.messageBytes+8192){reply('552 Message too large');socket.destroy();return}
   queue=queue.then(async()=>{
    while(buffer.includes('\r\n')){
     const split=buffer.indexOf('\r\n'),line=buffer.slice(0,split);buffer=buffer.slice(split+2)
     if(data){
      if(line!=='.'){body+=(line.startsWith('..')?line.slice(1):line)+'\r\n';if(Buffer.byteLength(body)>MAILBOX_LIMITS.messageBytes){reply('552 Message too large');socket.destroy();return}continue}
      if(acceptedMessages>=MAILBOX_LIMITS.messages){reply('452 Mailbox full');reset();continue}
      acceptedMessages++;try{await writeFile(join(directory,randomUUID()+'.eml'),body,{mode:0o600,flag:'wx'})}catch(error){acceptedMessages--;throw error}reply('250 Captured synthetic mail');reset();continue
     }
     if(authStep){let decoded;try{decoded=Buffer.from(line,'base64').toString('utf8')}catch{reply('535 Invalid credentials');authStep='';continue}
      if(authStep==='user'){loginUser=decoded;authStep='password';reply('334 UGFzc3dvcmQ6');continue}
      authenticated=loginUser===user&&decoded===password;authStep='';reply(authenticated?'235 Authenticated':'535 Invalid credentials');continue
     }
     const [command,...rest]=line.split(' '),arg=rest.join(' ')
     switch(command.toUpperCase()){
      case 'EHLO':case 'HELO':reply('250-fixture.example\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE '+MAILBOX_LIMITS.messageBytes);break
      case 'AUTH':{
       const [mechanism,encoded]=arg.split(' ')
       if(mechanism?.toUpperCase()==='PLAIN'&&encoded){const parts=Buffer.from(encoded,'base64').toString('utf8').split('\0');authenticated=parts.at(-2)===user&&parts.at(-1)===password;reply(authenticated?'235 Authenticated':'535 Invalid credentials')}
       else if(mechanism?.toUpperCase()==='LOGIN'){authStep='user';reply('334 VXNlcm5hbWU6')}else reply('504 Unsupported authentication')
       break}
      case 'MAIL':{reset();const address=/^FROM:(<[^>]*>)(?:\s.*)?$/i.exec(arg)?.[1];if(!authenticated)reply('530 Authenticate first');else if(!address||!mailboxAddress(address))reply('550 Synthetic .example sender required');else{sender=address;reply('250 Sender accepted')}break}
      case 'RCPT':{const address=/^TO:(<[^>]*>)(?:\s.*)?$/i.exec(arg)?.[1];if(!authenticated||!sender)reply('503 Sender required');else if(!address||!mailboxAddress(address))reply('550 Synthetic .example recipient required');else if(recipients.length>=8)reply('452 Recipient limit');else{recipients.push(address);reply('250 Recipient accepted')}break}
      case 'DATA':if(!authenticated||!sender||!recipients.length)reply('503 Recipient required');else{data=true;reply('354 End with dot')}break
      case 'RSET':reset();reply('250 Reset');break
      case 'NOOP':reply('250 OK');break
      case 'QUIT':socket.end('221 Goodbye\r\n');return
      default:reply('502 Unsupported command')
     }
    }
   }).catch(()=>{reply('451 Capture unavailable');socket.destroy()})
  })
 })
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',accept)})
 return {port:server.address().port,async close(){for(const socket of clients)socket.destroy();await new Promise(resolve=>server.close(resolve))}}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [directory,rawPort]=process.argv.slice(2);const mailbox=await createRigMailbox({directory,port:Number(rawPort)})
 console.log('[rig-mailbox] synthetic SMTP listening on loopback:'+mailbox.port)
 let closing=false;const close=async()=>{if(closing)return;closing=true;await mailbox.close();process.exit(0)}
 process.on('SIGTERM',close);process.on('SIGINT',close)
}
