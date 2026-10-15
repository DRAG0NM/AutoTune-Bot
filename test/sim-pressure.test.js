import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runSim} from '../bridge/backends/sim.js';
import {normalizeSimProfile} from '../bridge/lib/sim-options.js';
const zero={AngleKp:0,AngleKi:0,AngleKd:0};
const project=rows=>JSON.parse(JSON.stringify(rows.map(({ms,angle,target,out,errInt})=>({ms,angle,target,out,errInt}))));
test('identity pressure preserves all measured physics and control fields of frozen B',()=>{
  const dir=new URL('../evidence/05_validation/agnes-stage-b-20261010/',import.meta.url);
  const records=readFileSync(new URL('index.jsonl',dir),'utf8').trim().split('\n').map(JSON.parse);
  for(const r of records) {
    const rows=runSim({gains:r.gains,target:r.target,durationMs:r.durationMs,x0:r.meta.sim.x0,seed:r.meta.sim.seed,
      disturbance:r.meta.sim.disturbanceEvent?{atMs:r.meta.sim.disturbanceEvent.atMs,impulseDegPerSec:r.meta.sim.disturbance}:null,simProfile:{}});
    const lines=readFileSync(new URL(r.csv,dir),'utf8').trim().split(/\r?\n/);const keys=lines.shift().split(',');const historic=lines.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[keys[i],Number(v)])));
    assert.deepEqual(project(rows),project(historic));
    assert.equal(rows.simConfig.modelVersion,'sim-timing-2');
  }
});
test('dead zone and lag obey independent one-step plant oracle',()=>{
  const DEG=180/Math.PI,theta=3/DEG;
  for(const profile of [{deadZoneOutput:2},{actuatorLagMs:20},{deadZoneOutput:2,actuatorLagMs:20}]) {
    const rows=runSim({gains:{...zero,AngleKp:1},x0:3,durationMs:10,sampleMs:10,simProfile:{...profile,noise:0}});
    const command=3,dead=command-(profile.deadZoneOutput??0);
    const applied=dead*(profile.actuatorLagMs?1-Math.exp(-10/profile.actuatorLagMs):1);
    const alpha=9.81/.15*Math.sin(theta)-20/DEG*applied*Math.cos(theta);
    assert.equal(rows[0].out,command);
    assert.equal(rows[1].angle,Number(((theta+alpha*.0001)*DEG).toFixed(3)));
  }
  const hidden=runSim({gains:{...zero,AngleKp:1},durationMs:20,sampleMs:10,simProfile:{noise:0,deadZoneOutput:4}});
  const noControl=runSim({gains:zero,durationMs:20,sampleMs:10,noise:0});
  assert.deepEqual(hidden.map(r=>r.angle),noControl.map(r=>r.angle));
});
test('measurement delay repeats initial angle then shifts true-state history',()=>{
  const rows=runSim({gains:{...zero,AngleKp:1},durationMs:40,sampleMs:10,simProfile:{noise:0,measurementDelayMs:20}});
  assert.equal(rows[0].out,3);assert.equal(rows[1].out,3);assert.equal(rows[2].out,3);
  assert.equal(rows[3].out,Number(rows[1].angle.toFixed(2)));
  const scaled=runSim({gains:{...zero,AngleKp:1},durationMs:20,sampleMs:10,simProfile:{noise:0,controlScale:.5,dampingScale:1.5}});
  let th=3*Math.PI/180,om=0;
  for(let i=0;i<2;i++) {
    om+=(9.81/.15*Math.sin(th)-10/(180/Math.PI)*(th*180/Math.PI)*Math.cos(th)-6.45*om)*.01;
    th+=om*.01;
    assert.equal(scaled[i+1].angle,Number((th*180/Math.PI).toFixed(3)));
  }
  const o={gains:{AngleKp:6,AngleKi:0,AngleKd:16},simProfile:{noise:.5},seed:13};
  assert.deepEqual(runSim(o),runSim(o));assert.notDeepEqual(runSim(o),runSim({...o,seed:14}));
});
test('invalid pressure and non-sim use reject before creating evidence',()=>{
  for(const p of [null,[],{unknown:1},{noise:'1'},{noise:NaN},{controlScale:.49},{measurementDelayMs:15},{actuatorLagMs:201}])
    assert.throws(()=>normalizeSimProfile(p));
  const dir=mkdtempSync(join(tmpdir(),'pressure-'));
  try {
    const path=join(dir,'profile.json');writeFileSync(path,'{"noise":"1"}');
    const call=(...args)=>spawnSync(process.execPath,['bridge/cli.js','trial',...args,'--sim-profile',path,'--json'],{
      cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,AUTOTUNE_RUNS_DIR:join(dir,'runs')}});
    for(const backend of ['sim','replay','serial']) assert.notEqual(call('--backend',backend).status,0);
    assert.deepEqual(readdirSync(dir),['profile.json']);
    writeFileSync(path,'{"measurementDelayMs":10,"actuatorLagMs":10}');
    const first=call('--backend','sim','--campaign','profile-guard','--purpose','search','--reason','test');
    assert.equal(first.status,0,first.stderr);const r=JSON.parse(first.stdout);
    assert.deepEqual(r.meta.sim.simProfile,normalizeSimProfile({actuatorLagMs:10,measurementDelayMs:10}));
    writeFileSync(path,'{"actuatorLagMs":20}');
    const changed=call('--backend','sim','--campaign','profile-guard','--purpose','search','--reason','test','--parent',r.runId,
      '--gains','AngleKp=6,AngleKi=0,AngleKd=16');
    assert.notEqual(changed.status,0);assert.match(changed.stderr,/条件/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
