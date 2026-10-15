import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createServer as createSocketServer} from 'node:net';
import {randomUUID} from 'node:crypto';

const helper=resolve('tools/launch-agnes-web.mjs');
const run=(args)=>new Promise(resolveRun=>{const p=spawn(process.execPath,[helper,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('close',code=>resolveRun({code,stdout,stderr}));});
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'agnes-web-'));
 const files=[['agent.md','# AGNES\n引号 `不执行` $(不执行)\n中文身份'],['.agh/skills/pid-tuning/SKILL.md','# skill\n分析仿真后自主选择参数'],['docs/simulation-manual.md','# manual\n自动生成仿真报告']];
 for(const [path,text] of files){mkdirSync(join(dir,path,'..'),{recursive:true});writeFileSync(join(dir,path),text);}
 const cli=join(dir,'fake-cli.mjs');
 // External AGH process seam: real subprocess, UTF8 stdin and HTTP; no model or hardware.
 writeFileSync(cli,`import {writeFileSync,appendFileSync,readFileSync} from 'node:fs';import {createServer} from 'node:http';
const args=process.argv.slice(2),root=${JSON.stringify(dir)};appendFileSync(root+'/calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='serve'){writeFileSync(root+'/web.pid',String(process.pid));const port=Number(args[args.indexOf('--port')+1]);createServer((q,r)=>r.end('<html data-agnes-shell="workbench"><meta id="agnes-config"></html>')).listen(port,'127.0.0.1');}
else if(args[0]==='daemon')console.log(JSON.stringify({running:true,owner:{socketPath:readFileSync(root+'/socket.txt','utf8')}}));
else {let input='';for await(const b of process.stdin)input+=b.toString('utf8');writeFileSync(root+'/received.txt',input);if(readFileSync(root+'/mode.txt','utf8')==='failure'){console.error('model unavailable');process.exitCode=1;}else console.log(JSON.stringify({v:'agnes-cli-result/v1',sessionId:args.includes('--resume')?args[args.indexOf('--resume')+1]:'agnes:local:local-dev:cli:workspace:3372cde4f5acb8ca',reason:'completed',exitCode:0,lastSeq:3}));}`);
 writeFileSync(join(dir,'mode.txt'),'success');
 return {dir,cli,files,async cleanup(){if(existsSync(join(dir,'web.pid'))){const pid=Number(readFileSync(join(dir,'web.pid'),'utf8'));try{process.kill(pid);}catch{}for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}}await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}};
}
async function daemon(f,{ignoreSessionKey=false}={}){
 const path=process.platform==='win32'?'\\\\.\\pipe\\agnes-test-'+randomUUID():join(f.dir,'daemon.sock');
 const keys=[],s=createSocketServer(socket=>{let pending='';socket.setEncoding('utf8');socket.on('data',text=>{pending+=text;let nl;while((nl=pending.indexOf('\n'))>=0){const line=pending.slice(0,nl);pending=pending.slice(nl+1);const q=JSON.parse(line);let result={};if(q.method==='initialize'){assert.equal(q.params._meta['ai.agnes.harness'].auth.kind,'local');result={protocolVersion:1};}if(q.method==='session/new'){assert.equal(q.params.cwd,f.dir);const key=q.params._meta['ai.agnes.harness'].sessionKey;assert.equal(typeof key,'string');keys.push(key);result={sessionId:ignoreSessionKey?'agnes:local:local-dev:cli:workspace:3372cde4f5acb8ca':key};}socket.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');}});});
 await new Promise(r=>s.listen(path,r));writeFileSync(join(f.dir,'socket.txt'),path);
 return {keys,close:()=>new Promise(r=>s.close(r))};
}
test('web launch starts server once, injects complete UTF8 files via stdin and returns that session URL',{timeout:15000},async()=>{
 const f=fixture(),p=await port(),d=await daemon(f);try{
  const args=['--cli',f.cli,'--project',f.dir,'--port',String(p),'--profile','local-dev'];
  const first=await run(args);assert.equal(first.code,0,first.stderr);const result=JSON.parse(first.stdout.trim());
  assert.equal(new URL(result.url).searchParams.get('session'),result.sessionId);assert.match(result.sessionId,/^[a-f\d-]{36}$/);
  const prompt=readFileSync(join(f.dir,'received.txt'),'utf8');for(const [,text] of f.files)assert(prompt.includes(text));
  assert.match(prompt,/不运行仿真/);assert.equal(result.files.length,3);
  const saved=JSON.parse(readFileSync(result.receipt,'utf8'));assert.equal(saved.sessionId,result.sessionId);assert(saved.files.every(x=>x.sha256.length===64));
  const again=await run(args);assert.equal(again.code,0,again.stderr);
  assert.notEqual(JSON.parse(again.stdout).sessionId,result.sessionId);assert.equal(d.keys.length,2);
  const calls=readFileSync(join(f.dir,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(x=>x[0]==='serve').length,1);const submits=calls.filter(x=>x.includes('--mode'));assert.equal(submits.length,2);assert(submits.every(x=>x.includes('json')&&x.includes('--cwd')&&x.includes('--resume')));
 }finally{await d.close();await f.cleanup();}
});
test('missing instructions or unrelated occupied port refuse before model submission',{timeout:10000},async()=>{
 const f=fixture(),p=await port(),s=createServer((q,r)=>r.end('unrelated server'));try{
  await new Promise(r=>s.listen(p,'127.0.0.1',r));
  const args=['--cli',f.cli,'--project',f.dir,'--port',String(p),'--profile','local-dev'];
  assert.notEqual((await run(args)).code,0);assert.equal(existsSync(join(f.dir,'received.txt')),false);
  rmSync(join(f.dir,'agent.md'));assert.notEqual((await run(args)).code,0);assert.equal(existsSync(join(f.dir,'calls.jsonl')),false);
 }finally{await new Promise(r=>s.close(r));await f.cleanup();}
});
test('failed initial turn records session outcome and never claims injection ready',{timeout:10000},async()=>{
 const f=fixture(),p=await port(),d=await daemon(f);try{
  writeFileSync(join(f.dir,'mode.txt'),'failure');const result=await run(['--cli',f.cli,'--project',f.dir,'--port',String(p),'--profile','local-dev']);assert.notEqual(result.code,0);assert.match(result.stderr,/失败|failed|unavailable/);assert.equal(result.stdout.trim(),'');
 }finally{await d.close();await f.cleanup();}
});
test('daemon falling back to shared workspace session refuses before any initialization prompt',{timeout:10000},async()=>{
 const f=fixture(),p=await port(),d=await daemon(f,{ignoreSessionKey:true});try{
  const result=await run(['--cli',f.cli,'--project',f.dir,'--port',String(p),'--profile','local-dev']);assert.notEqual(result.code,0);assert.match(result.stderr,/独立会话/);assert.equal(existsSync(join(f.dir,'received.txt')),false);
 }finally{await d.close();await f.cleanup();}
});
