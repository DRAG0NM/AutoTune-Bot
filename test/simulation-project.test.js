import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'pendulum-project-'));return {dir,run:(...args)=>spawnSync(process.execPath,['bridge/cli.js',...args,'--json'],{cwd:root,encoding:'utf8',env:{...process.env,AUTOTUNE_RUNS_DIR:dir}}),close:()=>rmSync(dir,{recursive:true,force:true})};};
test('simulation project exposes only simulation parameters and rejects removed device commands without output',()=>{
 const f=fixture();try{
  const p=f.run('params');assert.equal(p.status,0,p.stderr);const cfg=JSON.parse(p.stdout);assert.equal(cfg.mode,'simulation-only');assert.equal(cfg.config.serial,undefined);
  for(const command of ['ports','inspect','set','start','stop','rollback']){assert.notEqual(f.run(command).status,0);}
  assert.notEqual(f.run('trial','--backend','serial').status,0);assert.deepEqual(readdirSync(f.dir),[]);
 }finally{f.close();}
});
test('trial automatically saves physical-state CSV, JSON, response and control charts and portable HTML',()=>{
 const f=fixture();try{
  const p=f.run('trial','--dur','10000','--gains','AngleKp=4,AngleKi=0,AngleKd=8');assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);
  assert.equal(r.durationMs,10000);assert(r.csv&&r.artifacts.response&&r.artifacts.control&&r.artifacts.phase&&r.artifacts.report);
  const csv=readFileSync(join(f.dir,r.csv),'utf8');assert.match(csv.split('\n')[0],/angularVelocity/);assert.doesNotMatch(csv.split('\n')[0],/spdL|spdR/);
  for(const key of ['response','control','phase']){const svg=readFileSync(join(f.dir,r.artifacts[key]),'utf8');assert.match(svg,/<svg/);assert.doesNotMatch(svg,/NaN/);}
  const report=readFileSync(join(f.dir,r.artifacts.report),'utf8');assert.match(report,/Simulation|仿真/);assert.doesNotMatch(report,/https?:\/\/.*(?:cdn|script)/);
  assert(existsSync(join(f.dir,r.artifacts.record)));assert.equal(JSON.parse(readFileSync(join(f.dir,'index.jsonl'),'utf8').trim()).artifacts.report,r.artifacts.report);
 }finally{f.close();}
});
test('campaign report includes failed and successful attempts, selects measured feasible point, and rejects CSV tampering',()=>{
 const f=fixture();try{
  const args=['trial','--backend','sim','--campaign','report-check','--purpose','search','--reason','fixture model feedback'];
  const first=JSON.parse(f.run(...args,'--gains','AngleKp=0,AngleKi=0,AngleKd=0').stdout);
  const second=JSON.parse(f.run(...args,'--gains','AngleKp=4,AngleKi=0,AngleKd=8','--parent',first.runId).stdout);
  const p=f.run('report','--campaign','report-check');assert.equal(p.status,0,p.stderr);const report=JSON.parse(p.stdout);
  assert.equal(report.total,2);assert.equal(report.best.runId,second.runId);assert.equal(report.failed,1);
  assert.equal(report.parameterChangeExecuted,true);assert.equal(report.distinctSearchPoints,2);
  const table=readFileSync(report.files.metricsCsv,'utf8');assert(table.includes(first.runId)&&table.includes(second.runId));assert.match(table,/Infinity/);
  for(const key of ['historySvg','gainsSvg','html'])assert(existsSync(report.files[key]));
  writeFileSync(join(f.dir,first.csv),readFileSync(join(f.dir,first.csv),'utf8')+'\n');
  const bad=f.run('report','--campaign','report-check');assert.notEqual(bad.status,0);assert.match(bad.stderr,/hash|散列/);
 }finally{f.close();}
});

test('no feasible point still produces a report and altered eligibility is rejected',()=>{
 const f=fixture();try{
  const p=f.run('trial','--campaign','no-feasible','--purpose','search','--reason','failed fixture','--gains','Kp=0,Ki=0,Kd=0');assert.equal(p.status,0,p.stderr);
  const report=f.run('report','--campaign','no-feasible');assert.equal(report.status,0,report.stderr);const s=JSON.parse(report.stdout);assert.equal(s.best,null);assert.equal(s.parameterChangeExecuted,false);
  const index=join(f.dir,'index.jsonl'),r=JSON.parse(readFileSync(index,'utf8'));r.decisionEligible=true;writeFileSync(index,JSON.stringify(r)+'\n');
  const bad=f.run('report','--campaign','no-feasible');assert.notEqual(bad.status,0);assert.match(bad.stderr,/资格/);
 }finally{f.close();}
});

test('60-second simulation preserves control timing; missing replay state remains unknown',()=>{
 const f=fixture();try{
  const p=f.run('trial','--dur','60000','--gains','Kp=4,Ki=0,Kd=8');assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);const rows=readFileSync(join(f.dir,r.csv),'utf8').trim().split('\n');assert.equal(rows.length,1202);assert.match(rows.at(-1),/^60000,/);
  const csv=join(f.dir,'minimal.csv');writeFileSync(csv,'ms,angle,target,out\n'+Array.from({length:21},(_,i)=>`${i*50},0,0,0`).join('\n')+'\n');
  const replay=f.run('trial','--backend','replay','--csv',csv);assert.equal(replay.status,0,replay.stderr);const rr=JSON.parse(replay.stdout);assert.equal(rr.decisionEligible,false);assert.equal(rr.gains,null);const data=readFileSync(join(f.dir,rr.csv),'utf8');assert.match(data,/\n0,0,0,,0,,\n/);
 }finally{f.close();}
});
