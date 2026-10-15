#!/usr/bin/env node
/** Read-only verification of the published real-AGNES simulation evidence. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {parseGainList} from '../bridge/lib/protocol.js';
const normalize=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='number'&&!Number.isFinite(v)?Number.isNaN(v)?null:String(v):v));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const args=process.argv.slice(2);assert(args.length===0||(args.length===2&&args[0]==='--root'),'用法: verify-submission.js [--root EVIDENCE_DIRECTORY]');
 const root=args.length?path.resolve(args[1]):fileURLToPath(new URL('../evidence/07_simulation-release-20261015/',import.meta.url));
 const safe=p=>{assert(typeof p==='string'&&!path.isAbsolute(p)&&!p.split(/[\\/]/).includes('..'),'非法证据路径');return path.join(root,p);};
 const json=p=>JSON.parse(fs.readFileSync(safe(p),'utf8'));
 const jsonl=p=>fs.readFileSync(safe(p),'utf8').trim().split(/\r?\n/).map(JSON.parse);
 const manifest=json('manifest.json');assert.equal(manifest.schema,'autotune-submission-evidence/1');
 for(const file of manifest.files)assert.equal(sha(fs.readFileSync(safe(file.path))),file.sha256,'hash mismatch: '+file.path);
 const combined=createHash('sha256');for(const file of manifest.sourceFiles)combined.update(file).update(fs.readFileSync(safe('source/'+file)));
 assert.equal(combined.digest('hex'),manifest.combinedSourceHash,'frozen source hash');
 const {runSim}=await import(pathToFileURL(safe('source/bridge/backends/sim.js')).href);
 const {computeMetrics}=await import(pathToFileURL(safe('source/bridge/lib/metrics.js')).href);
 const {loadCsv}=await import(pathToFileURL(safe('source/bridge/backends/replay.js')).href);
 const records=jsonl('campaign/index.jsonl');assert.equal(records.length,7,'expected seven recorded trials');
 const hashes=new Map(manifest.files.map(f=>[f.path,f.sha256]));
 let previous=null;
 for(const r of records){
  assert.equal(r.campaign,manifest.campaign);assert.equal(r.backend,'sim');assert.equal(r.sourceHash,manifest.combinedSourceHash);
  assert.equal(r.decision.parent,previous?.runId??null,'parent chain');previous=r;
  assert.equal(path.basename(r.csv),r.csv);assert.equal(hashes.get('campaign/'+r.csv),r.csvHash,'record/manifest CSV hash');
  const s=r.meta.sim,event=s.disturbanceEvent;
  const rows=runSim({gains:r.gains,target:r.target,durationMs:r.durationMs,x0:s.x0,seed:s.seed,simProfile:s.simProfile,simController:s.controller,
   disturbance:event?{atMs:event.atMs,impulseDegPerSec:event.amplitude}:null});
  assert.deepEqual(normalize([...rows]),normalize(loadCsv(safe('campaign/'+r.csv))),'reproduced state trajectory: '+r.runId);
  assert.deepEqual(normalize(computeMetrics(rows,{...r.evaluation.metrics,weights:r.evaluation.weights,termination:s.termination})),r.metrics,'full frozen metrics: '+r.runId);
 }
 const events=jsonl('agh-session.jsonl');assert.equal(events[0].seq,1);
 for(let i=1;i<events.length;i++)assert.equal(events[i].seq,events[i-1].seq+1,'事件sequence gap');
 const calls=events.filter(e=>e.type==='tool/call'),results=events.filter(e=>e.type==='tool/result');
 const pair=(left,right,key)=>{
  assert.equal(new Set(left.map(e=>e.data[key])).size,left.length,'duplicate '+key);
  assert.equal(new Set(right.map(e=>e.data[key])).size,right.length,'duplicate '+key);
  assert.deepEqual(left.map(e=>e.data[key]).sort(),right.map(e=>e.data[key]).sort(),'unpaired '+key);
 };
 pair(calls,results,'toolUseId');pair(events.filter(e=>e.type==='effect/intent'),events.filter(e=>e.type==='effect/settled'),'effectId');
 assert(events.filter(e=>e.type==='effect/settled').every(e=>Number.isInteger(e.data.durationMs)&&e.data.durationMs>=0),'invalid effect duration');
 const start=events.find(e=>e.type==='session/start');assert.equal(start.data.key,manifest.session);
 assert(start.data.modelSettings.every(s=>s.model==='agnes-3.0-flash'),'unexpected runtime model');
 let previousResult=-1;const coverage=[];
 for(const r of records){
  const result=results.find(e=>!e.data.isError&&JSON.stringify(e.data.content).includes(r.runId));assert(result,'missing model tool return: '+r.runId);
  const call=calls.find(e=>e.data.toolUseId===result.data.toolUseId);assert.equal(call.origin,'model');assert(call.seq>previousResult,'model trial calls must follow preceding feedback');
  const command=call.data.args.command;assert(command.includes('bridge/cli.js trial'));
  const gains=command.match(/--gains\s+(['"])(.*?)\1/);assert(gains,'missing explicit gains');assert.deepEqual(parseGainList(gains[2]),r.gains,'proposal/executed gains mismatch');
  previousResult=result.seq;coverage.push({runId:r.runId,callSeq:call.seq,resultSeq:result.seq});
 }
 const lastStart=events.filter(e=>e.type==='turn/start').at(-1),lastEnd=events.filter(e=>e.type==='turn/end').at(-1);
 assert(lastEnd.seq>lastStart.seq&&lastEnd.data.reason==='completed','last turn incomplete');
 const searches=records.filter(r=>r.decision.purpose==='search'),validation=records.filter(r=>r.decision.purpose==='robustness');
 const feasible=searches.filter(r=>r.decisionEligible&&Number.isFinite(r.metrics.j)),best=feasible.reduce((a,b)=>!a||b.metrics.j<a.metrics.j?b:a,null);
 assert(best);assert(validation.every(r=>JSON.stringify(r.gains)===JSON.stringify(best.gains)),'validation candidate changed');
 console.log(JSON.stringify({verified:true,session:manifest.session,events:events.length,toolCalls:calls.length,toolResults:results.length,runsReproduced:records.length,runCoverage:coverage.length,
  distinctSearchPoints:new Set(searches.map(r=>JSON.stringify(r.gains))).size,best:{gains:best.gains,j:best.metrics.j},validationCount:validation.length,
  validationPassed:validation.every(r=>r.metrics.converged&&!r.metrics.fail),wallMs:Date.parse(lastEnd.ts)-Date.parse(lastStart.ts),coverage},null,2));
}catch(error){console.error(JSON.stringify({verified:false,error:error.message}));process.exitCode=1;}
