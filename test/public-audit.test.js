import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const fixture=()=>{
 const dir=mkdtempSync(join(tmpdir(),'public-audit-'));
 const run=(...args)=>spawnSync(process.execPath,['bridge/cli.js',...args,'--json'],{encoding:'utf8',env:{...process.env,AUTOTUNE_RUNS_DIR:dir}});
 const trial=(campaign,gains,parent,extra=[])=>run('trial','--campaign',campaign,'--gains',gains,'--purpose','search','--reason','audit fixture',...(parent?['--parent',parent]:[]),...extra);
 return {dir,run,trial,close:()=>rmSync(dir,{recursive:true,force:true})};
};
test('validation refuses nonconverged or nonchampion parameters before writing artifacts',()=>{
 const f=fixture();try{
  const first=JSON.parse(f.trial('candidate-guard','Kp=5,Ki=0.1,Kd=5').stdout);
  let files=readdirSync(f.dir).sort();
  const invalid=f.run('trial','--campaign','candidate-guard','--purpose','robustness','--reason','cannot validate an infeasible point','--parent',first.runId,'--gains','Kp=5,Ki=0.1,Kd=5','--seed','12');
  assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/可行|最优/);assert.deepEqual(readdirSync(f.dir).sort(),files);
  const best=JSON.parse(f.trial('candidate-guard','Kp=4,Ki=0,Kd=8',first.runId).stdout);
  const other=JSON.parse(f.trial('candidate-guard','Kp=4,Ki=0,Kd=12',best.runId).stdout);files=readdirSync(f.dir).sort();
  const wrong=f.run('trial','--campaign','candidate-guard','--purpose','robustness','--reason','wrong champion','--parent',other.runId,'--gains','Kp=4,Ki=0,Kd=12','--seed','12');
  assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/最优/);assert.deepEqual(readdirSync(f.dir).sort(),files);
  const good=f.run('trial','--campaign','candidate-guard','--purpose','robustness','--reason','frozen champion','--parent',other.runId,'--gains','Kp=4,Ki=0,Kd=8','--seed','12');assert.equal(good.status,0,good.stderr);
 }finally{f.close();}
});
test('validation cannot change metric thresholds after search',()=>{
 const f=fixture();try{
  const first=JSON.parse(f.trial('metric-guard','Kp=4,Ki=0,Kd=8').stdout),before=readFileSync(join(f.dir,'index.jsonl'),'utf8');
  const p=f.run('trial','--campaign','metric-guard','--purpose','robustness','--reason','altered evaluation','--parent',first.runId,'--gains','Kp=4,Ki=0,Kd=8','--seed','12','--fallLimit','49');
  assert.notEqual(p.status,0);assert.match(p.stderr,/评价/);assert.equal(readFileSync(join(f.dir,'index.jsonl'),'utf8'),before);
 }finally{f.close();}
});
test('report recomputes oscillation and weighted contributions and accepts legacy missing additive fields',()=>{
 const f=fixture();try{
  const p=f.trial('all-metrics','Kp=4,Ki=0,Kd=8');assert.equal(p.status,0,p.stderr);const original=JSON.parse(p.stdout),index=join(f.dir,'index.jsonl');
  for(const key of ['osc','jContributions','dominantCostTerm','reason']){
   const changed=structuredClone(original);if(key==='jContributions')changed.metrics[key].energy=99;else changed.metrics[key]=key==='osc'?999:'energy';
   writeFileSync(index,JSON.stringify(changed)+'\n');const bad=f.run('report','--campaign','all-metrics');assert.notEqual(bad.status,0,key);assert.match(bad.stderr,/指标复算/);
   const audit=spawnSync(process.execPath,['tools/verify-campaign.js','--campaign','all-metrics'],{encoding:'utf8',env:{...process.env,AUTOTUNE_RUNS_DIR:f.dir}});assert.notEqual(audit.status,0,key);assert.match(audit.stderr,/指标/);
  }
  delete original.metrics.jContributions;delete original.metrics.dominantCostTerm;writeFileSync(index,JSON.stringify(original)+'\n');
  const legacy=f.run('report','--campaign','all-metrics');assert.equal(legacy.status,0,legacy.stderr);
 }finally{f.close();}
});
test('charts leave gaps when replay has missing actuator-state observations',()=>{
 const f=fixture();try{
  const source=join(f.dir,'replay-input.csv');
  writeFileSync(source,'ms,angle,target,out,appliedOut\n'+Array.from({length:21},(_,i)=>`${i*50},0,0,1,${i<5||i>15?'1':''}`).join('\n')+'\n');
  const p=f.run('trial','--backend','replay','--csv',source);assert.equal(p.status,0,p.stderr);
  const r=JSON.parse(p.stdout),svg=readFileSync(join(f.dir,r.artifacts.control),'utf8');
  assert.equal((svg.match(/<polyline data-series="applied"/g)??[]).length,2,'unknown middle observations must break the plotted line');
  assert.equal((svg.match(/<polyline data-series="command"/g)??[]).length,1);
 }finally{f.close();}
});
test('malformed configuration sections cannot disable round budgets',()=>{
 const dir=mkdtempSync(join(tmpdir(),'config-shape-'));try{
  mkdirSync(join(dir,'bridge/lib'),{recursive:true});mkdirSync(join(dir,'configs'));writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  for(const file of ['config.js','store.js'])copyFileSync(resolve('bridge/lib',file),join(dir,'bridge/lib',file));
  const code=`import {loadConfig} from ${JSON.stringify(pathToFileURL(join(dir,'bridge/lib/config.js')).href)};console.log(JSON.stringify(loadConfig()));`;
  for(const patch of [{agents:0},{agents:[]},{agents:{maxRounds:{}}},{metrics:0},{cost:[]}]){
   writeFileSync(join(dir,'configs/bridge.local.json'),JSON.stringify(patch));const p=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.notEqual(p.status,0,JSON.stringify(patch));
  }
  writeFileSync(join(dir,'configs/bridge.local.json'),'{"agents":{"maxRounds":7}}');const p=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).config.agents.maxRounds,7);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
