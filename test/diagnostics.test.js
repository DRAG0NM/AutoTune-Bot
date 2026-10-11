import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {diagnose} from '../bridge/lib/diagnostics.js';

const s=(ms,angle=0,out=0)=>({ms,angle,target:0,out});
test('diagnostics keeps zero metrics zero and integrates irregular intervals',()=>{
  const zero=diagnose([s(0),s(100),s(900)]);
  assert.equal(zero.error.iaeDegSec,0);assert.equal(zero.tail.rmsErrorDeg,0);
  assert.equal(zero.integral.available,false);
  const m=diagnose([s(0,2,100),s(100,1,2),s(900)]);
  assert.equal(m.error.iaeDegSec,1);assert.ok(Math.abs(m.error.iseDeg2Sec-1.2)<1e-12);
  assert.equal(m.output.energyOutputSquaredSec,1003.2);
  assert.equal(m.output.observedSaturatedFraction,100/900);
  assert.equal(m.tail.meanAbsErrorDeg,1);
});
test('signed mean cannot hide tail oscillation and no recovery is invented',()=>{
  const m=diagnose([s(0,1),s(500,-1),s(1000,1)],{tailFraction:1,disturbanceAtMs:500});
  assert.equal(m.tail.meanErrorDeg,0);assert.equal(m.tail.rmsErrorDeg,1);
  assert.equal(m.disturbance.recoveryMs,null);assert.equal(m.disturbance.recovered,false);
  const short=diagnose([s(0,3),s(1000,0),s(1200,0)],{disturbanceAtMs:1000});
  assert.equal(short.disturbance.recovered,false);
});
test('disturbance peak excludes large initial angle, unavailable events and integral are explicit',()=>{
  const samples=[s(0,30),s(1000,1),s(1500,0),s(2000,0)];
  const m=diagnose(samples,{disturbanceAtMs:1000,maxGapMs:500});
  assert.equal(m.disturbance.observedPeakErrorDeg,1);assert.equal(m.disturbance.recoveryMs,500);
  assert.equal(diagnose(samples,{disturbanceAtMs:2500}).disturbance.observed,false);
  assert.equal(diagnose(samples,{disturbanceAtMs:1000}).disturbance.recovered,false);
  assert.equal(diagnose(samples.map(x=>({...x,errInt:0})),{integralAvailable:false}).integral.available,false);
  assert.throws(()=>diagnose([s(0),s(0)]));assert.throws(()=>diagnose(samples,{holdMs:0}));
});
test('CSV-only diagnostic does not invent errInt or overwrite input/output',()=>{
  const dir=mkdtempSync(join(tmpdir(),'autotune-diagnostic-'));
  try {
    const file=join(dir,'data.csv');writeFileSync(file,'ms,angle,target,out\n0,0,0,0\n500,0,0,0\n');
    const call=(...args)=>spawnSync(process.execPath,['tools/diagnose.js','--csv',file,...args],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
    const r=call();assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).results[0].diagnostics.integral.available,false);
    assert.notEqual(call('--out',file).status,0);assert.notEqual(call('--at','NaN').status,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
