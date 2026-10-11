#!/usr/bin/env node
// 从真实 CSV 复算并导出完整 campaign；不执行后端，不改原始记录。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { paths, readIndex } from '../bridge/lib/store.js';
import { loadCsv } from '../bridge/backends/replay.js';
import { computeMetrics } from '../bridge/lib/metrics.js';
import { diagnose } from '../bridge/lib/diagnostics.js';
import {simConditions} from '../bridge/lib/sim-options.js';
import {normalizeSimController} from '../bridge/lib/sim-controller.js';

try {
  const args=process.argv.slice(2), flags={};
  for(let i=0;i<args.length;i+=2) {
    if(!['--campaign','--out'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--') || flags[args[i]])
      throw new Error('用法: --campaign <标识> [--out <新目录>]');
    flags[args[i]]=args[i+1];
  }
  const campaign=flags['--campaign'];
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(campaign ?? '')) throw new Error('缺少或非法 campaign');
  const records=readIndex().filter(r=>r.campaign===campaign);
  if(!records.length) throw new Error('campaign 没有记录');
  const ids=new Set();
  let previous=null;
  for(const r of records) {
    if(r.backend!=='sim' || r.evaluation?.version!=='2.3') throw new Error('本工具只验证 v2.3 sim campaign');
    if(!r.runId || ids.has(r.runId)) throw new Error('runId 缺失或重复');
    if((r.decision?.parent??null)!==(previous?.runId??null)) throw new Error('parent 不属于此前的本次记录');
    ids.add(r.runId);previous=r;
    if(!r.csv || basename(r.csv)!==r.csv) throw new Error('CSV 文件名非法');
    const file=resolve(paths.runs,r.csv);
    if(createHash('sha256').update(readFileSync(file)).digest('hex')!==r.csvHash) throw new Error(`CSV hash 不符: ${r.runId}`);
    const actual=computeMetrics(loadCsv(file),{...r.evaluation.metrics,weights:r.evaluation.weights});
    for(const k of ['fail','converged','n','j','overshoot','settlingMs','ssErr','osc','energy']) {
      const normalized=v=> typeof v==='number' && !Number.isFinite(v)?(Number.isNaN(v)?null:String(v)):v;
      if(normalized(actual[k])!==r.metrics[k]) throw new Error(`指标 ${k} 不符: ${r.runId}`);
    }
  }
  if(new Set(records.map(r=>r.meta.sim.modelVersion??'legacy-1')).size!==1) throw Error('仿真模型版本不一致');
  const controllers=new Set(records.map(r=>JSON.stringify(normalizeSimController(r.meta.sim.controller??{}))));
  if(controllers.size!==1) throw Error('campaign 不允许混用 simController');
  const hashes=new Set(records.map(r=>r.sourceHash));
  for(const r of records.filter(r=>r.diagnostics)) {
    const d=diagnose(loadCsv(resolve(paths.runs,r.csv)),{tolerance:r.metrics.tol??r.evaluation.metrics.tolFloor,
      holdMs:r.evaluation.metrics.settleHoldMs,disturbanceAtMs:r.meta.sim.disturbanceEvent?.atMs??null});
    if(JSON.stringify(d)!==JSON.stringify(r.diagnostics)) throw Error(`诊断不符: ${r.runId}`);
  }
  if(hashes.size!==1 || !/^[a-f0-9]{64}$/.test(records[0].sourceHash)) throw new Error('campaign 源码身份不一致');
  const searches=records.filter(r=>r.decision.purpose==='search');
  const c=r=>simConditions({durationMs:r.durationMs,target:r.target,x0:r.meta.sim.x0,seed:r.meta.sim.seed,disturbance:r.meta.sim.disturbance,simProfile:r.meta.sim.simProfile,simController:r.meta.sim.controller});
  const conditions=r=>JSON.stringify({...c(r),evaluation:r.evaluation});
  if(new Set(searches.map(conditions)).size>1) throw new Error('搜索工况不一致，不允许混排');
  const plan=records[0].experimentPlan??null;
  const validation=records.filter(r=>r.decision.purpose==='robustness');
  if(records.some(r=>JSON.stringify(r.experimentPlan??null)!==JSON.stringify(plan))) throw Error('plan身份不一致');
  if(plan) {
    if(searches.length>plan.maxSearch || validation.length!==plan.validation.length) throw Error('预算超限或验证场景未完成');
    if(searches.some(r=>JSON.stringify(c(r))!==JSON.stringify(simConditions(plan.search))) ||
      validation.some((r,i)=>JSON.stringify(c(r))!==JSON.stringify(simConditions(plan.validation[i])))) throw Error('plan场景不符');
    if(new Set(validation.map(r=>JSON.stringify(r.gains))).size>1) throw Error('验证候选未冻结');
  }
  const feasible=searches.filter(r=>!r.metrics.fail && r.metrics.converged && Number.isFinite(r.metrics.j) &&
    (plan?.objective!=='impulse-recovery' || r.diagnostics?.disturbance?.recovered===true));
  const best=feasible.reduce((a,b)=>!a||b.metrics.j<a.metrics.j?b:a,null);
  const summary={verified:true,campaign,sourceHash:records[0].sourceHash,total:records.length,searches:searches.length,
    distinctSearchPoints:new Set(searches.map(r=>JSON.stringify(r.gains))).size,
    planComplete:plan?true:null,validationCount:validation.length,
    best:best?{runId:best.runId,gains:best.gains,j:best.metrics.j,converged:true}:null,
    controller:normalizeSimController(records[0].meta.sim.controller??{}),
    validationPassed:validation.length?validation.every(r=>!r.metrics.fail && r.metrics.converged &&
      (!r.meta.sim.disturbanceEvent || r.diagnostics?.disturbance?.recovered===true)):null,
    robustness:records.filter(r=>r.decision.purpose==='robustness').map(r=>({runId:r.runId,conditions:r.meta.sim,metrics:r.metrics,disturbanceRecovery:r.diagnostics?.disturbance??null}))};
  if(flags['--out']) {
    const out=resolve(flags['--out']);
    if(existsSync(out) || !relative(paths.runs,out).startsWith('..')) throw new Error('导出目录必须新建且在原始 runs 目录之外');
    mkdirSync(out,{recursive:true});
    for(const r of records) copyFileSync(resolve(paths.runs,r.csv),resolve(out,r.csv));
    writeFileSync(resolve(out,'index.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
    writeFileSync(resolve(out,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  }
  console.log(JSON.stringify(summary,null,2));
} catch(e) { console.error(JSON.stringify({verified:false,error:e.message})); process.exitCode=1; }
