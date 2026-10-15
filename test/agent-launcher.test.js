import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('PowerShell launcher uses WSL web helper, opens returned session and refuses missing files', {skip:process.platform!=='win32'},()=>{
 const dir=mkdtempSync(join(tmpdir(),"agnes instructions 中文 '-"));
 try{
  mkdirSync(join(dir,'tools'));
  const launcher=join(dir,'启动调参助手.ps1');
  copyFileSync(resolve('启动调参助手.ps1'),launcher);
  const command=`$ErrorActionPreference='Stop'; function global:wsl.exe { [Console]::Error.WriteLine('CAPTURE:'+ (ConvertTo-Json -InputObject @($args) -Compress)); $global:LASTEXITCODE=0; '{"v":"autotune-web-launch/1","url":"http://127.0.0.1:4177/?session=agnes%3Alocal%3Alocal-dev%3Aweb%3Adm%3Atest","sessionId":"agnes:local:local-dev:web:dm:test"}' }; function global:Start-Process { param($FilePath) [Console]::WriteLine('OPEN:'+ $FilePath) }; & '${launcher.replaceAll("'","''")}' -AghCli '/home/drag0nm/agh/packages/cli/dist/local/agnes.mjs'`;
  const run=()=>spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',cwd:tmpdir()});
  const missing=run();
  assert.notEqual(missing.status,0,'missing instructions must block AGH launch');
  assert.doesNotMatch(missing.stderr,/CAPTURE:/);
  const instruction='# 身份约束\n我是 AGNES 项目助手。\n引号 " 和单引号 \' 与 --cwd 保持为正文。';
  writeFileSync(join(dir,'agent.md'),instruction);
  mkdirSync(join(dir,'.agh/skills/pid-tuning'),{recursive:true});mkdirSync(join(dir,'docs'));
  writeFileSync(join(dir,'.agh/skills/pid-tuning/SKILL.md'),'技能全文');writeFileSync(join(dir,'docs/simulation-manual.md'),'手册全文');writeFileSync(join(dir,'tools/launch-agnes-web.mjs'),'// helper verified separately');
  const loaded=run();
  assert.equal(loaded.status,0,loaded.stderr);
  const args=JSON.parse(loaded.stderr.split(/\r?\n/).find(s=>s.startsWith('CAPTURE:')).slice(8));
  assert.deepEqual(args.slice(0,4),['-d','Ubuntu-24.04','--exec','node']);
  assert.match(args[4],/\/tools\/launch-agnes-web\.mjs$/);
  assert.equal(args[args.indexOf('--cli')+1],'/home/drag0nm/agh/packages/cli/dist/local/agnes.mjs');
  const resolved=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',`[IO.Path]::GetFullPath('${dir.replaceAll("'","''")}')`],{encoding:'utf8'});
  assert.equal(resolved.status,0,resolved.stderr);
  const windowsProject=resolved.stdout.trim().replaceAll('\\','/');
  const expectedProject='/mnt/'+windowsProject[0].toLowerCase()+windowsProject.slice(2);
  assert.equal(args[args.indexOf('--project')+1],expectedProject);
  assert.equal(args[4],expectedProject+'/tools/launch-agnes-web.mjs');
  assert.match(loaded.stdout,/OPEN:http:\/\/127.0.0.1:4177\/\?session=agnes%3Alocal/);
  assert.match(loaded.stdout,/agent\.md.*SHA256/i);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
