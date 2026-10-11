import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSim } from '../bridge/backends/sim.js';
import { computeMetrics } from '../bridge/lib/metrics.js';
import { loadCsv } from '../bridge/backends/replay.js';
import { parseGainList, parseTelemetry } from '../bridge/lib/protocol.js';

const root = new URL('../', import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'autotune-test-'));
after(() => rmSync(dir, {recursive:true, force:true}));
const tuned = { AngleKp: 4, AngleKi: 0, AngleKd: 8 };
const cli = (...args) => spawnSync(process.execPath, ['bridge/cli.js', ...args,
  ...(args.includes('--campaign')&&!args.includes('--reason')?['--reason','regression']:[])], {
  cwd: root, encoding: 'utf8', env: { ...process.env, AUTOTUNE_RUNS_DIR: dir },
});
const csv = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

test('between-sample fall survives CSV round trip and is never a feasible candidate', () => {
  const r = cli('trial','--backend','sim','--gains','AngleKp=3,AngleKi=0,AngleKd=2','--json');
  assert.equal(r.status, 0, r.stderr);
  const record = JSON.parse(r.stdout);
  assert.equal(record.metrics.fail, true);
  assert.equal(record.metrics.j, 'Infinity');
  assert.equal(record.meta.sim.termination.atMs, 2570);
  assert.equal(record.meta.sim.termination.angleDeg, 50.112);
  const replay = computeMetrics(loadCsv(join(dir, record.csv)));
  assert.equal(replay.fail, true);
  assert.match(replay.reason, /摔倒/);
});

test('fixed seed is reproducible; a new seed changes the data', () => {
  assert.deepEqual(runSim({gains:tuned}), runSim({gains:tuned}));
  assert.notDeepEqual(runSim({gains:tuned}), runSim({gains:tuned,seed:20261009}));
});

test('normal candidate stays converged after failure fix', () => {
  const m = computeMetrics(runSim({gains:tuned}));
  assert.equal(m.converged, true);
  assert.equal(m.j, .149);
});

test('CSV uses named ms column and preserves short excursions', () => {
  const file = csv('reordered.csv','angle,target,ms,out\n0,0,0,1\n51,0,10,1\n0,0,50,1\n');
  const samples = loadCsv(file);
  assert.equal(samples[1].ms, 10);
  assert.equal(samples[1].angle, 51);
  assert.equal(computeMetrics(samples).fail, true);
});

test('CSV rejects invalid numbers, missing cells, and duplicate/decreasing times', () => {
  for (const body of ['0,wat,0,0\n50,0,0,0','0,,0,0\n50,0,0,0','0,0,0\n50,0,0,0',
    '0,0,0,0\n0,0,0,0','50,0,0,0\n0,0,0,0']) {
    assert.throws(()=>loadCsv(csv('invalid.csv','ms,angle,target,out\n'+body+'\n')));
  }
});

test('metrics cannot report success for NaN, stale timestamps, or changing target', () => {
  const base = runSim({gains:tuned});
  for (const change of [{angle:NaN},{ms:-1},{target:1},{out:Infinity}]) {
    const samples = base.map(s=>({...s})); samples[10] = {...samples[10],...change};
    assert.equal(computeMetrics(samples).fail,true);
  }
});

test('invalid trial options do not run or create evidence', () => {
  for (const args of [['--dur','NaN'],['--seed','-1'],['--x0','NaN'],['--gains','AngleKp='],
    ['--dur','5000'],['--tag','../escape'],['--bogus','1'],['--seed'],['--seed','1','--seed','2'],
    ['--gains','AngleKp=21'],['--gains','AngleKp=4,AngleKp=5'],['--json','false']]) {
    const r=cli('trial','--backend','sim','--json',...args);
    assert.notEqual(r.status,0,JSON.stringify(args));
    assert.equal(JSON.parse(r.stderr.trim()).ok,false);
  }
});

test('campaign evidence records conditions, source identity and decisions', () => {
  const r=cli('trial','--backend','sim','--gains','AngleKp=4,AngleKi=0,AngleKd=8',
    '--seed','12','--x0','-3','--campaign','regression','--reason','compare damping','--purpose','search','--json');
  assert.equal(r.status,0,r.stderr);
  const x=JSON.parse(r.stdout);
  assert.equal(x.campaign,'regression'); assert.equal(x.meta.sim.seed,12); assert.equal(x.meta.sim.x0,-3);
  assert.equal(x.decision.reason,'compare damping'); assert.match(x.sourceHash,/^[a-f0-9]{64}$/);
  assert.ok(readFileSync(join(dir,x.csv)).length>0);
});

test('grid with only nonconverged candidates reports no optimum, Infinity stays explicit', () => {
  const r=spawnSync(process.execPath,['tools/scan.js','--ki','0','--kps','3','--kds','2','--json'],{cwd:root,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const x=JSON.parse(r.stdout);
  assert.equal(x.best,null); assert.equal(x.rows[0].j,'Infinity'); assert.equal(x.rows[0].fail,true);
});

test('protocol rejects malformed gains and empty/out-of-range telemetry fields', () => {
  assert.throws(()=>parseGainList('AngleKp=4,garbage'));
  assert.throws(()=>parseGainList('AngleKp=4=8'));
  assert.throws(()=>parseGainList('SpeedKp=1'));
  assert.equal(parseTelemetry('T,0,,0,0,0,0,0'),null);
  assert.equal(parseTelemetry('T,-1,0,0,0,0,0,0'),null);
  assert.equal(parseTelemetry('T,4294967296,0,0,0,0,0,0'),null);
});

test('late single in-band sample is not convergence; energy uses actual intervals', () => {
  const samples = Array.from({length:20},(_,i)=>({ms:i*50,angle:i===19?0:1,target:0,out:2}));
  const m=computeMetrics(samples);
  assert.equal(m.converged,false);
  assert.equal(m.settlingMs,Infinity);
  samples[19].ms=2000;
  assert.equal(computeMetrics(samples).energy,8);
  assert.equal(computeMetrics(samples,{minSamples:0}).fail,true);
});

test('replay cannot claim supplied gains and grid cannot silently drop malformed tokens', () => {
  assert.notEqual(cli('trial','--backend','replay','--csv','testdata/sample_step_response.csv','--gains','AngleKp=4','--json').status,0);
  const r=spawnSync(process.execPath,['tools/scan.js','--kps','4,nope','--json'],{cwd:root,encoding:'utf8'});
  assert.notEqual(r.status,0);
});

test('campaign export includes failures, recomputes CSV and rejects tampering', () => {
  const first=JSON.parse(cli('trial','--backend','sim','--gains','AngleKp=3,AngleKi=0,AngleKd=2','--campaign','export-check','--purpose','search','--json').stdout);
  const second=JSON.parse(cli('trial','--backend','sim','--gains','AngleKp=4,AngleKi=0,AngleKd=8','--campaign','export-check','--purpose','search','--parent',first.runId,'--json').stdout);
  const verify=()=>spawnSync(process.execPath,['tools/verify-campaign.js','--campaign','export-check'],{
    cwd:root,encoding:'utf8',env:{...process.env,AUTOTUNE_RUNS_DIR:dir}});
  let r=verify(); assert.equal(r.status,0,r.stderr);
  const summary=JSON.parse(r.stdout);
  assert.equal(summary.total,2); assert.equal(summary.distinctSearchPoints,2); assert.equal(summary.best.runId,second.runId);
  writeFileSync(join(dir,first.csv),readFileSync(join(dir,first.csv),'utf8').replace('50.112','49'));
  r=verify(); assert.notEqual(r.status,0); assert.match(r.stderr,/hash/);
});

test('campaign verifier rejects controller identity that differs from the frozen plan',()=>{
  const search={durationMs:3000,target:0,x0:3,seed:20261008,disturbance:null,
    simProfile:{},simController:{name:'baseline'}};
  const validation={...search,seed:20261009};
  const plan=join(dir,'controller-plan.json');
  writeFileSync(plan,JSON.stringify({campaign:'controller-plan-check',objective:'regulation',maxSearch:1,
    gainRanges:{AngleKp:[3,8],AngleKi:[0,.02],AngleKd:[4,16]},search,validation:[validation]}));
  const args=['trial','--backend','sim','--campaign','controller-plan-check','--plan',plan,
    '--gains','AngleKp=4,AngleKi=0,AngleKd=8','--sim-controller','baseline','--json'];
  const first=cli(...args,'--purpose','search'); assert.equal(first.status,0,first.stderr);
  const parent=JSON.parse(first.stdout).runId;
  const second=cli(...args,'--purpose','robustness','--parent',parent,'--seed','20261009');
  assert.equal(second.status,0,second.stderr);
  const index=join(dir,'index.jsonl');
  const records=readFileSync(index,'utf8').trim().split(/\r?\n/).map(JSON.parse);
  for(const record of records.filter(r=>r.campaign==='controller-plan-check'))
    record.meta.sim.controller={name:'conditional-integral',derivativeFilterMs:null};
  writeFileSync(index,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const verify=spawnSync(process.execPath,['tools/verify-campaign.js','--campaign','controller-plan-check'],{
    cwd:root,encoding:'utf8',env:{...process.env,AUTOTUNE_RUNS_DIR:dir}});
  assert.notEqual(verify.status,0);
  assert.match(verify.stderr,/plan场景不符/);
});

test('campaign rejects duplicate points, invalid parent and changed search conditions before writing',()=>{
  const args=['trial','--backend','sim','--campaign','guard-check','--purpose','search','--json'];
  const first=JSON.parse(cli(...args,'--gains','AngleKp=4,AngleKi=0,AngleKd=8').stdout);
  const before=readFileSync(join(dir,'index.jsonl'),'utf8');
  for(const extra of [[],['--parent',first.runId],['--parent',first.runId,'--seed','13']]) {
    assert.notEqual(cli(...args,'--gains','AngleKp=4,AngleKi=0,AngleKd=8',...extra).status,0);
  }
  assert.equal(readFileSync(join(dir,'index.jsonl'),'utf8'),before);
  const r=cli(...args,'--gains','AngleKp=5,AngleKi=0,AngleKd=8','--parent',first.runId);
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).diagnostics.version,'1.0');
});

test('non-sim campaign cannot contaminate sim evidence and declared plan budgets are enforced',()=>{
  assert.notEqual(cli('trial','--backend','replay','--csv','testdata/sample_step_response.csv','--campaign','guard-check','--json').status,0);
  const plan=join(dir,'plan.json'),conditions={durationMs:3000,target:0,x0:3,seed:20261008,disturbance:null};
  writeFileSync(plan,JSON.stringify({campaign:'plan-check',objective:'regulation',maxSearch:1,search:conditions,
    gainRanges:{AngleKp:[3,8],AngleKi:[0,.02],AngleKd:[4,16]},validation:[{...conditions,seed:1}]}));
  const args=['trial','--backend','sim','--plan',plan,'--campaign','plan-check','--json','--gains','AngleKp=4,AngleKi=0,AngleKd=8'];
  const first=cli(...args,'--purpose','search');assert.equal(first.status,0,first.stderr);
  const id=JSON.parse(first.stdout).runId;
  const before=readFileSync(join(dir,'index.jsonl'),'utf8');
  const nextArgs=args.slice();nextArgs[nextArgs.indexOf('--gains')+1]='AngleKp=5,AngleKi=0,AngleKd=8';
  const exhausted=cli(...nextArgs,'--purpose','search','--parent',id);
  assert.notEqual(exhausted.status,0);assert.match(exhausted.stderr,/预算/);
  assert.equal(readFileSync(join(dir,'index.jsonl'),'utf8'),before);
  assert.notEqual(cli(...args,'--purpose','robustness','--parent',id,'--seed','2').status,0);
  const r=cli(...args,'--purpose','robustness','--parent',id,'--seed','1');assert.equal(r.status,0,r.stderr);
});
