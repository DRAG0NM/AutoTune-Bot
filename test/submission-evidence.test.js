import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const call=(...args)=>spawnSync(process.execPath,['tools/verify-submission.js',...args],{encoding:'utf8'});
test('submission evidence independently reproduces seven runs and pairs the real model tool chain',()=>{
 const r=call();assert.equal(r.status,0,r.stderr);const j=JSON.parse(r.stdout);assert.equal(j.verified,true);assert.equal(j.runsReproduced,7);assert.equal(j.runCoverage,7);assert.equal(j.distinctSearchPoints,4);assert.equal(j.validationPassed,false);
});
test('submission evidence rejects changed CSV and a rehashed ledger with a missing event',()=>{
 const dir=mkdtempSync(join(tmpdir(),'submission-audit-'));try{
  const target=join(dir,'evidence');cpSync('evidence/07_simulation-release-20261015',target,{recursive:true});
  const r=JSON.parse(readFileSync(join(target,'campaign/index.jsonl'),'utf8').split('\n')[0]);
  const csv=join(target,'campaign',r.csv),bytes=readFileSync(csv);writeFileSync(csv,Buffer.concat([bytes,Buffer.from('\n')]));
  let failed=call('--root',target);assert.notEqual(failed.status,0);assert.match(failed.stderr,/hash|散列/);
  writeFileSync(csv,bytes);
  const ledger=join(target,'agh-session.jsonl'),rows=readFileSync(ledger,'utf8').trim().split('\n');rows.splice(20,1);writeFileSync(ledger,rows.join('\n')+'\n');
  const manifest=join(target,'manifest.json'),m=JSON.parse(readFileSync(manifest,'utf8'));m.files.find(f=>f.path==='agh-session.jsonl').sha256=createHash('sha256').update(readFileSync(ledger)).digest('hex');writeFileSync(manifest,JSON.stringify(m));
  failed=call('--root',target);assert.notEqual(failed.status,0);assert.match(failed.stderr,/sequence|seq|事件/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
