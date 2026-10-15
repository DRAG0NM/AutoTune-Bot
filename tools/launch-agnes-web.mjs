import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){
 if(!['--cli','--project','--profile','--port'].includes(args[i])||!args[i+1]||options[args[i]]!==undefined)throw new Error('启动参数无效');
 options[args[i]]=args[i+1];
}
const cli=options['--cli'],project=options['--project'],profile=options['--profile']??'local-dev',port=Number(options['--port']??4177);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const validSessionId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/.test(id);
async function newWebSession(cli,project,profile,env){
 // Use the installed daemon's public local discovery, then the same authenticated
 // Unix ACP initialize/session-new calls as its Web SDK. No credential files.
 const {stdout}=await promisify(execFile)(process.execPath,[cli,'daemon','status','--profile',profile],{cwd:project,env,timeout:10000});
 const status=JSON.parse(stdout);if(status.running!==true||typeof status.owner?.socketPath!=='string')throw new Error('AGNES后台尚未就绪');
 const socket=createConnection(status.owner.socketPath),pending=new Map();let seq=0,buffer='';
 socket.setEncoding('utf8');
 const rejectAll=e=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
 socket.on('error',rejectAll);socket.on('close',()=>rejectAll(new Error('创建网页会话的本地连接已关闭')));
 socket.on('data',text=>{
  buffer+=text;let nl;
  while((nl=buffer.indexOf('\n'))>=0){
   let row;try{row=JSON.parse(buffer.slice(0,nl));}catch{rejectAll(new Error('本地会话响应格式无效'));socket.destroy();return;}buffer=buffer.slice(nl+1);
   if(row.method){if(row.id!==undefined)socket.write(JSON.stringify({jsonrpc:'2.0',id:row.id,error:{code:-32601,message:'Launcher does not approve or execute tools'}})+'\n');continue;}
   const p=pending.get(row.id);if(!p)continue;pending.delete(row.id);clearTimeout(p.timer);if(row.error)p.reject(new Error(row.error.message));else p.resolve(row.result);
  }
 });
 const call=(method,params)=>new Promise((resolveCall,reject)=>{
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('创建网页会话超时：'+method));},15000);
  pending.set(id,{resolve:resolveCall,reject,timer});socket.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 try{
  const init=await call('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}},_meta:{'ai.agnes.harness':{clientId:randomUUID(),auth:{kind:'local'}}}});
  if(init.protocolVersion!==1)throw new Error('本地会话协议版本不匹配');
  await call('_agnes/v1/workspace.add',{path:project});
  const sessionKey=randomUUID();
  const created=await call('session/new',{cwd:project,mcpServers:[],_meta:{'ai.agnes.harness':{sessionKey}}});
  if(!validSessionId(created.sessionId)||created.sessionId!==sessionKey)throw new Error('后台没有创建指定独立会话；不向旧会话注入');
  return {sessionId:created.sessionId,sessionKey};
 }finally{socket.destroy();}
}
async function main(){
 if(!isAbsolute(cli??'')||!isAbsolute(project??'')||!Number.isInteger(port)||port<1||port>65535)throw new Error('需绝对路径与有效端口');
 const origin=`http://127.0.0.1:${port}`;
 const files=['agent.md','.agh/skills/pid-tuning/SKILL.md','docs/simulation-manual.md'].map(path=>{
  const text=readFileSync(join(project,path),'utf8');if(!text.trim())throw new Error('指令为空：'+path);
  return {path,text,sha256:createHash('sha256').update(text).digest('hex')};
 });
 const launchDir=join(project,'state','agnes-web',randomUUID());mkdirSync(launchDir,{recursive:true});
 const env={...process.env,AGNES_WEB_ORIGIN:origin},webLog=join(launchDir,'web.log');
 async function webReady(){
  let response;try{response=await fetch(origin,{signal:AbortSignal.timeout(1000)});}catch{return false;}
  const text=await response.text();if(!response.ok||!text.includes('data-agnes-shell="workbench"')||!text.includes('id="agnes-config"'))throw new Error('端口被其他服务占用，未提交项目指令');
  return true;
 }
 let webPid=null;
 if(!await webReady()){
  const fd=openSync(webLog,'a');let web;
  try{web=spawn(process.execPath,[cli,'serve','--cwd',project,'--profile',profile,'--port',String(port)],{cwd:project,env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  let failure=null;web.on('error',e=>failure=e);web.on('exit',code=>failure=new Error('网页进程退出：'+code));web.unref();webPid=web.pid;
  const deadline=Date.now()+120000;
  while(!await webReady()){if(failure)throw new Error(failure.message+'；日志：'+webLog);if(Date.now()>deadline)throw new Error('网页启动超时；日志：'+webLog);await sleep(250);}
 }
 const prompt='这是操作者要求的一次新网页会话初始化。以下三个文件为当前项目真实全文，作为本次用户任务上下文，不冒充系统提示词。\n\n'+files.map(f=>`===== ${f.path} SHA256=${f.sha256} =====\n${f.text}\n===== END ${f.path} =====`).join('\n\n')+
 '\n\n本次初始化只需确认已收到三份文件，用大白话询问本次调参时间预算、最多试验轮数与目标（快速恢复/低超调/低控制量）；已有信息不反复询问。建议12轮搜索加3轮验证、每轮模拟3秒。本条只初始化，不调用工具、不运行仿真。等我回答后，在预算内自主完成仿真调参和CSV/图表报告，无需逐轮确认。';
 writeFileSync(join(launchDir,'initial-context.txt'),prompt);
 const receiptPath=join(launchDir,'launch.json');
 const receipt={schema:'autotune-web-launch/1',at:new Date().toISOString(),project,profile,origin,webPid,files:files.map(({path,sha256})=>({path,sha256})),state:'submitting'};
 const save=()=>writeFileSync(receiptPath,JSON.stringify(receipt,null,2));save();
 let created;
 try{created=await newWebSession(cli,project,profile,env);}catch(e){receipt.state='failed';receipt.reason='session-create-failed';receipt.error=e.message;save();throw new Error(e.message+'；日志：'+receiptPath);}
 receipt.sessionId=created.sessionId;receipt.sessionKey=created.sessionKey;receipt.url=origin+'/?session='+encodeURIComponent(created.sessionId);save();
 // Official CLI's one-shot JSON adapter shares the daemon and persists a normal
 // session. stdin preserves arbitrary UTF8/Markdown without shell expansion.
 const result=await new Promise((resolveResult,reject)=>{
  const child=spawn(process.execPath,[cli,'--cwd',project,'--profile',profile,'--resume',created.sessionId,'--mode','json'],{cwd:project,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',timedOut=false;
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGINT');},180000);
  const cancel=()=>child.kill('SIGINT');process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  child.once('error',e=>{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);reject(e);});
  child.once('close',code=>{clearTimeout(timer);process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);resolveResult({code,stdout,stderr,timedOut});});
  child.stdin.on('error',()=>{});child.stdin.end(prompt,'utf8');
 });
 writeFileSync(join(launchDir,'initial-result.jsonl'),result.stdout);writeFileSync(join(launchDir,'initial-stderr.log'),result.stderr);
 const row=result.stdout.trim().split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).findLast(x=>x?.v==='agnes-cli-result/v1');
 receipt.state='failed';receipt.exitCode=result.code;receipt.reason=row?.reason??(result.timedOut?'timeout':'no-result');
 if(result.code!==0||row?.exitCode!==0||row?.reason!=='completed'||row.sessionId!==created.sessionId){save();throw new Error('会话初始化失败；检查：'+receiptPath+'；已有会话：'+receipt.url);}
 receipt.state='ready';save();
 console.log(JSON.stringify({v:'autotune-web-launch/1',sessionId:receipt.sessionId,url:receipt.url,files:receipt.files,receipt:resolve(receiptPath)}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
