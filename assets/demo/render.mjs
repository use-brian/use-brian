import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(resolve(root,'apps/app-web/package.json'));
const sharp=require(require.resolve('sharp',{paths:[dirname(require.resolve('next/package.json'))]}));
const workDir=resolve(process.env.DEMO_WORK_DIR || resolve(tmpdir(),'use-brian-readme-demo'));
const dir=resolve(workDir,'frames');
const output=resolve(root,'assets');
const scenes=JSON.parse(await readFile(resolve(dir,'scenes.json'),'utf8'));
const W=1200,H=820,FPS=12;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const text=(s,x,y,size,color='#262923',more='')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" ${more}>${esc(s)}</text>`;
const chapters=['Feature showcase','Built for business and teams','Connectivity'];
const total=scenes.reduce((n,s)=>n+s.duration,0);
await mkdir(resolve(dir,'composed'),{recursive:true});
const ff=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(FPS),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',resolve(output,'demo.mp4')],{stdio:['pipe','inherit','inherit']});
const done=new Promise((resolve,reject)=>{ff.once('error',reject);ff.once('exit',code=>code===0?resolve():reject(new Error('ffmpeg exited '+code)))});
const previews=[];let elapsed=0;
for(let i=0;i<scenes.length;i++){
 const s=scenes[i];
 const shot=await sharp(resolve(dir,s.id+'.png')).resize(1100,620).png().toBuffer();
 const chapter=chapters.indexOf(s.chapter)+1;
 const overlay=`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><g font-family="Helvetica,Arial,sans-serif">${text(`0${chapter} / ${s.chapter.toUpperCase()}`,50,33,13,'#60685b','letter-spacing="1.5"')}${text('USE BRIAN',1150,33,16,'#282d25','text-anchor="end" font-weight="600"')}${text(s.title,50,81,32,'#22261f','font-weight="600"')}${text(s.caption,50,781,20,'#4f5949')}${text('Example workspace',1150,109,12,'#77806e','text-anchor="end"')}${text(String(i+1).padStart(2,'0')+' / '+scenes.length,1150,781,12,'#77806e','text-anchor="end"')}<rect x="49.5" y="124.5" width="1101" height="621" rx="9" fill="none" stroke="#d4d8cf"/></g></svg>`;
 const base=await sharp({create:{width:W,height:H,channels:3,background:'#f1f3ed'}}).composite([{input:shot,left:50,top:125},{input:Buffer.from(overlay)}]).png().toBuffer();
 await writeFile(resolve(dir,'composed',s.id+'.png'),base);
 if(i===0)await writeFile(resolve(output,'demo/poster.png'),base);
 previews.push({input:await sharp(base).resize(400).png().toBuffer(),left:(i%3)*400,top:Math.floor(i/3)*274});
 for(let j=0;j<s.duration*FPS;j++){
  const progress=(elapsed+j/FPS)/total;
  const bar=`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="815" width="${Math.round(W*progress)}" height="5" fill="#6d7b61"/></svg>`;
  const frame=await sharp(base).composite([{input:Buffer.from(bar)}]).png().toBuffer();
  if(!ff.stdin.write(frame))await once(ff.stdin,'drain');
 }
 elapsed+=s.duration;console.log(`${i+1}/${scenes.length}: ${s.id}`);
}
ff.stdin.end();await done;
await sharp({create:{width:1200,height:Math.ceil(scenes.length/3)*274,channels:3,background:'#f1f3ed'}}).composite(previews).png().toFile(resolve(dir,'contact-sheet.png'));
// A single palette and frame differencing keep a long, mostly-static UI tour small.
const gif=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',resolve(output,'demo.mp4'),'-filter_complex','fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle','-loop','0',resolve(output,'demo.gif')],{stdio:'inherit'});
await new Promise((resolve,reject)=>{gif.once('error',reject);gif.once('exit',code=>code===0?resolve():reject(new Error('GIF render failed')))});
console.log(`Rendered ${total}s at ${W}x${H}; README GIF 960px.`);
