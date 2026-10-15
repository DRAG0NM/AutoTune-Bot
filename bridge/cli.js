#!/usr/bin/env node
/** Simulation-only inverted-pendulum experiments and automatic reports. */

import {isAbsolute,resolve as presolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';

import {parseGainList,SIM_DEFAULTS,TUNABLE} from './lib/protocol.js';
import { computeMetrics } from './lib/metrics.js';
import { diagnose } from './lib/diagnostics.js';
import { loadConfig, costWeights } from './lib/config.js';
import { writeRunCsv, appendIndex, readIndex, paths } from './lib/store.js';
import { runSim, SIM_PRESETS, SIM_MODEL_VERSION } from './backends/sim.js';
import { runReplay } from './backends/replay.js';
import {normalizeSimProfile,simConditions} from './lib/sim-options.js';
import {normalizeSimController} from './lib/sim-controller.js';
import {writeTrialArtifacts,writeCampaignReport} from './lib/reports.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flagErrors = [];
const flags = parseFlags(rest);
const positional = rest.filter((a) => !a.startsWith('--'));

function parseFlags(list) {
  const f = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) { if (cmd === 'trial') flagErrors.push(`多余的位置参数: ${a}`); continue; }
    const key = a.slice(2);
    if (Object.hasOwn(f, key)) flagErrors.push(`重复选项: --${key}`);
    const next = list[i + 1];
    if (['json','help'].includes(key)) { f[key] = true; continue; }
    if (next === undefined || next.startsWith('--')) { f[key] = true; }
    else { f[key] = next; i++; }
  }
  return f;
}

const emit = (obj, human) => {
  if (flags.json) console.log(JSON.stringify(obj, null, 2));
  else console.log(human ?? JSON.stringify(obj, null, 2));
};

async function main() {
  if (flagErrors.length) throw new Error(flagErrors.join('; '));
  if (!cmd || flags.help) return usage();

  switch (cmd) {
    case 'params': return cmdParams();
    case 'trial': return cmdTrial();
    case 'selftest': return cmdSelftest();
    case 'runs': return cmdRuns();
    case 'report': return cmdReport();
    default: throw Error('未知命令；本项目仅支持仿真、回放和报告');
  }
}

function usage(){console.log('PID AI 仿真助手\n命令: params | selftest | trial --backend sim --gains "Kp=4,Ki=0,Kd=8" --json | report --campaign ID --json | runs\ntrial自动生成CSV、JSON、响应/控制/相图SVG及HTML；不包含设备后端。');}
function cmdParams(){const {config,source}=loadConfig();emit({mode:'simulation-only',model:'nonlinear second-order single pendulum',defaults:SIM_DEFAULTS,tunable:TUNABLE,config,configSource:source});}
function cmdReport(){for(const k of Object.keys(flags))if(!['campaign','out','json'].includes(k))throw Error('未知report选项: '+k);emit(writeCampaignReport({campaign:flags.campaign,outDir:flags.out}));}
async function cmdTrial() {
  const { config: cfg, source: cfgSource } = loadConfig();
  const backend = flags.backend ?? 'sim';
  if(!['sim','replay'].includes(backend))throw Error('仅支持sim/replay；设备后端已移除');
  const durationMs = Number(flags.dur ?? cfg.trial.durationMs);
  const target = Number(flags.target ?? 0);
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 60000)
    throw new Error('trial 时长必须是 1000–60000ms 的有限数字');
  if (!Number.isFinite(target)) throw new Error('target 必须是有限数字');
  const allowed = ['backend','dur','target','gains','json','x0','seed','disturb','csv',
    'fallLimit','tag','campaign','reason','parent','purpose','plan','sim-profile','sim-controller'];
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`未知 trial 选项: --${key}`);
  for (const key of ['backend','dur','target','gains','x0','seed','disturb','csv','fallLimit','tag','campaign','reason','parent','purpose','plan','sim-profile','sim-controller'])
    if (flags[key] === true) throw new Error(`--${key} 缺少值`);
  if (flags.tag && !/^[a-zA-Z0-9_-]{1,80}$/.test(flags.tag)) throw new Error('非法 tag');
  if (flags.campaign && !/^[a-zA-Z0-9_-]{1,80}$/.test(flags.campaign)) throw new Error('非法 campaign');
  if(backend!=='sim' && (flags.campaign || flags.plan)) throw Error('campaign/plan本轮仅允许sim，不污染其他后端记录');
  if(backend!=='sim' && (flags['sim-profile'] || flags['sim-controller'])) throw Error('sim-profile/sim-controller 仅允许 sim 后端');
  const simProfile=normalizeSimProfile(flags['sim-profile']?JSON.parse(readFileSync(presolve(paths.root,flags['sim-profile']),'utf8')):{});
  let simControllerInput={};
  if (flags['sim-controller']) {
    if (flags['sim-controller'].toLowerCase().endsWith('.json')) {
      simControllerInput=JSON.parse(readFileSync(presolve(paths.root,flags['sim-controller']),'utf8'));
    } else simControllerInput={name:flags['sim-controller']};
  }
  const simController=normalizeSimController(simControllerInput);
  if (backend === 'replay' && flags.gains !== undefined) throw new Error('replay 为只读，不能指定 --gains');
  const fallLimit = Number(flags.fallLimit ?? cfg.metrics.fallLimitDeg);
  if (!Number.isFinite(fallLimit) || fallLimit <= 0 || fallLimit > 50) throw new Error('fallLimit 必须在 (0,50] 度');
  const good = SIM_DEFAULTS;
  const gains = backend === 'replay' ? null : parseGainList(flags.gains, good);
  let experimentPlan=null;
  if(flags.plan) {
    if(!flags.campaign) throw Error('plan要求campaign');
    experimentPlan=JSON.parse(readFileSync(presolve(paths.root,flags.plan),'utf8'));
    if(experimentPlan.campaign!==flags.campaign || !Number.isInteger(experimentPlan.maxSearch) ||
      experimentPlan.maxSearch<1 || experimentPlan.maxSearch>12 || !Array.isArray(experimentPlan.validation) ||
      experimentPlan.validation.length<1 || experimentPlan.validation.length>6 || !experimentPlan.search || !['regulation','impulse-recovery'].includes(experimentPlan.objective) ||
      !TUNABLE.every(k=>Array.isArray(experimentPlan.gainRanges?.[k]) && experimentPlan.gainRanges[k].length===2 &&
        experimentPlan.gainRanges[k].every(Number.isFinite) && experimentPlan.gainRanges[k][0]<=experimentPlan.gainRanges[k][1]))
      throw Error('实验plan非法');
    experimentPlan.search=simConditions(experimentPlan.search);
    experimentPlan.validation=experimentPlan.validation.map(simConditions);
  }
  if(backend==='sim' && flags.campaign) {
    const prior=readIndex().filter(r=>r.campaign===flags.campaign);
    const purpose=flags.purpose;
    if(!['search','robustness'].includes(purpose) || !flags.reason?.trim()) throw Error('campaign必须指定search/robustness和非空reason');
    if(prior.length>=cfg.agents.maxRounds) throw Error('campaign总预算已耗尽');
    if(prior.length && prior.at(-1).sourceHash!==sourceHash()) throw Error('源码身份改变，请新建campaign');
    if(prior.length ? flags.parent!==prior.at(-1).runId : flags.parent!==undefined) throw Error('parent必须是本campaign上一轮runId，首轮不传parent');
    const conditions=simConditions({durationMs,target,x0:Number(flags.x0??3),seed:Number(flags.seed??20261008),disturbance:flags.disturb?Number(flags.disturb):null,simProfile,simController});
    const conditionOf=r=>simConditions({durationMs:r.durationMs,target:r.target,x0:r.meta.sim.x0,seed:r.meta.sim.seed,disturbance:r.meta.sim.disturbance,simProfile:r.meta.sim.simProfile,simController:r.meta.sim.controller});
    const search=prior.filter(r=>r.decision.purpose==='search');
    if(search.length && (JSON.stringify({...cfg.metrics,fallLimitDeg:fallLimit})!==JSON.stringify(search[0].evaluation.metrics) ||
      JSON.stringify(costWeights(cfg))!==JSON.stringify(search[0].evaluation.weights))) throw Error('评价配置改变，请新建campaign');
    if(purpose==='robustness') {
      const eligible=search.filter(r=>r.decisionEligible===true&&Number.isFinite(r.metrics.j));
      const best=eligible.reduce((a,b)=>!a||b.metrics.j<a.metrics.j?b:a,null);
      if(!best || !TUNABLE.every(k=>gains[k]===best.gains[k])) throw Error('验证参数必须是当前已测可行最优，未运行试验');
    }
    if(prior.length && JSON.stringify(experimentPlan)!==JSON.stringify(prior[0].experimentPlan)) throw Error('plan改变，请新建campaign');
    if(experimentPlan) {
      const validations=prior.filter(r=>r.decision.purpose==='robustness');
      if(purpose==='search' && (search.length>=experimentPlan.maxSearch || validations.length)) throw Error('搜索预算耗尽或已冻结候选');
      const expected=purpose==='search'?experimentPlan.search:experimentPlan.validation[validations.length];
      if(!expected || JSON.stringify(conditions)!==JSON.stringify(expected)) throw Error('试验条件不符合预先声明plan');
      for(const k of TUNABLE) {
        const bounds=experimentPlan.gainRanges?.[k];
        if(!Array.isArray(bounds)||bounds.length!==2||!bounds.every(Number.isFinite)||gains[k]<bounds[0]||gains[k]>bounds[1]) throw Error('参数超出plan范围');
      }
      if(validations.length && JSON.stringify(gains)!==JSON.stringify(validations[0].gains)) throw Error('验证阶段候选已冻结');
    }
    if(purpose==='search' && search.length && (JSON.stringify(conditions)!==JSON.stringify(conditionOf(search[0])) ||
      JSON.stringify({...cfg.metrics,fallLimitDeg:fallLimit})!==JSON.stringify(search[0].evaluation.metrics) ||
      JSON.stringify(costWeights(cfg))!==JSON.stringify(search[0].evaluation.weights))) throw Error('搜索条件或评价配置改变，请新建campaign');
    const signature=g=>TUNABLE.map(k=>g[k]);
    if(prior.some(r=>JSON.stringify(signature(r.gains))===JSON.stringify(signature(gains)) &&
      JSON.stringify(conditionOf(r))===JSON.stringify(conditions))) throw Error('campaign已有相同参数和条件，不重复试验');
  }
  const started = performance.now();

  let samples = [];
  let meta = { backend, durationMs, target, configSource: cfgSource };

  if (backend === 'sim') {
    samples = runSim({
      gains, target, durationMs,simProfile,simController,
      x0: Number(flags.x0 ?? 3),
      seed: Number(flags.seed ?? 20261008),
      disturbance: flags.disturb
        ? { atMs: Math.floor(durationMs * 0.5), impulseDegPerSec: Number(flags.disturb) }
        : null,
    });
    meta.sim = { ...samples.simConfig,
      timeSemantics:'state-at-t; output held on [t,t+dt); terminal output held from prior interval',x0: Number(flags.x0 ?? 3), seed: Number(flags.seed ?? 20261008),
      disturbance: flags.disturb ? Number(flags.disturb) : null,
      disturbanceEvent:flags.disturb?{type:'angular-velocity-impulse',atMs:Math.floor(durationMs*0.5),
        amplitude:Number(flags.disturb),unit:'deg/s'}:null,termination: samples.termination };
  } else if (backend === 'replay') {
    if (!flags.csv) throw new Error('replay 后端需要 --csv <文件>');
    const file = isAbsolute(flags.csv) ? flags.csv : presolve(paths.root, flags.csv);
      samples = runReplay({ file });
    meta.csv = file;
    meta.requestedTarget = target;
    meta.requestedDurationMs = durationMs;
    meta.target = samples[0]?.target ?? null;
    meta.durationMs = samples.length ? samples.at(-1).ms - samples[0].ms : 0;
  } else {
    throw new Error(`未知后端: ${backend}`);
  }

  const metrics = computeMetrics(samples, {
    ...cfg.metrics,
    termination: meta.sim?.termination,
    fallLimitDeg: fallLimit,
    weights: costWeights(cfg),
  });

  const csvName = samples.length ? writeRunCsv(flags.tag ?? backend, samples) : null;
  const record = {
    runId: randomUUID(),
    ts: new Date().toISOString(),
    backend, gains, target: meta.target, durationMs: meta.durationMs, csv: csvName,
    csvHash: csvName ? createHash('sha256').update(readFileSync(presolve(paths.runs, csvName))).digest('hex') : null,
    campaign: flags.campaign ?? null,
    decision: { reason: flags.reason ?? null, parent: flags.parent ?? null, purpose: flags.purpose ?? 'unspecified' },
    experimentPlan,
    evaluation: { version: '2.3', metrics: { ...cfg.metrics, fallLimitDeg: fallLimit }, weights: costWeights(cfg) },
    sourceHash: sourceHash(),
    meta,
    wallMs: Math.max(0, Math.round(performance.now() - started)),
    metrics: sampleSafe(metrics),
    diagnostics: backend==='sim' && samples.length>=2 ? diagnose(samples,{tolerance:metrics.tol??cfg.metrics.tolFloor,
      holdMs:cfg.metrics.settleHoldMs,disturbanceAtMs:meta.sim.disturbanceEvent?.atMs??null}) : null,
  };
  record.decisionEligible = backend === 'sim' && metrics.ok && metrics.converged &&
    (experimentPlan?.objective!=='impulse-recovery' || record.diagnostics?.disturbance?.recovered===true);
  record.artifacts=writeTrialArtifacts(record,samples);
  appendIndex(record);

  emit({...record,verdict:metrics.fail?'failed':metrics.converged?'converged':'not_converged'});
}

async function cmdSelftest() {
  // v2：自检也走配置文件，保证"自检通过的值"与"真跑时的值"是同一套口径
  const { config: cfg, source: cfgSource } = loadConfig();
  const metricOpts = { ...cfg.metrics, weights: costWeights(cfg) };

  const cases = [];
  for (const [key, preset] of Object.entries(SIM_PRESETS)) {
    const samples = runSim({ gains: preset.gains, durationMs: cfg.trial.durationMs });
    const m = computeMetrics(samples, metricOpts);
    cases.push({ key, label: preset.label, gains: preset.gains, metrics: sampleSafe(m) });
  }

  // 回放样例（若存在示例 CSV）
  try {
    const samples = runReplay({ file: presolve(paths.root, 'testdata/sample_step_response.csv') });
    cases.push({
      key: 'replay-sample',
      label: '回放：示例数据集（合成数据，非真实实验）',
      gains: null,
      metrics: sampleSafe(computeMetrics(samples, metricOpts)),
    });
  } catch (e) {
    cases.push({ key: 'replay-sample', label: `回放跳过：${e.message}`, metrics: null });
  }

  const expect = {
    // 正常类：应当收敛
    'normal-tuned': (m) => m && !m.fail && m.converged,
    'normal-conservative': (m) => m && !m.fail && m.converged,
    // 边界类：不摔倒、指标可计算即可（允许性能一般）
    'boundary-high-kd': (m) => m && !m.fail,
    'boundary-zero-ki': (m) => m && !m.fail,
    // 失败类：应当被正确识别为失败/不收敛
    'fail-no-control': (m) => m && m.fail,
    'fail-between-samples': (m) => m && m.fail && m.termination?.reason === 'fall',
    'fail-underdamped': (m) => m && (m.fail || m.osc >= 2),
    'fail-windup': (m) => m && !m.converged,
    'replay-sample': (m) => m && m.ok,
  };

  const rows = cases.map((c) => {
    const pass = expect[c.key] ? expect[c.key](c.metrics) : true;
    return {
      样例: c.key,
      说明: c.label,
      判定: pass ? 'PASS' : 'FAIL',
      收敛: c.metrics ? (c.metrics.fail ? '摔倒/失败' : c.metrics.converged ? '是' : '否') : '-',
      超调: fmt(c.metrics?.overshoot),
      调节ms: fmt(c.metrics?.settlingMs),
      振荡: fmt(c.metrics?.osc),
      J: fmt(c.metrics?.j),
    };
  });

  const allPass = rows.every((r) => r.判定 === 'PASS');
  await Promise.resolve(); // 保持 async 形状
  if (flags.out) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(flags.out), { recursive: true });
    writeFileSync(flags.out, JSON.stringify({ ts: new Date().toISOString(), allPass, cases }, null, 2), 'utf8');
  }
  emit(
    { allPass,  cases },
    `${table(rows)}\n总体: ${allPass ? 'PASS' : 'FAIL'}`
  );
  if (!allPass) process.exitCode = 1;
}

function cmdRuns() {
  const idx = readIndex();
  const rows = idx.slice(-20).map((r) => ({
    时间: r.ts.slice(11, 19),
    后端: r.backend,
    参数: JSON.stringify(r.gains),
    判定: r.metrics?.fail ? '失败' : r.metrics?.converged ? '收敛' : '未收敛',
    J: fmt(r.metrics?.j),
  }));
  emit({ total: idx.length, runsRoot: paths.runs, last: idx.slice(-20) }, `${table(rows)}\n\n实验总数: ${idx.length}  数据目录: ${paths.runs}`);
}

// ---------- 小工具 ----------
const fmt = (v) => (v === Infinity ? '∞' : Number.isFinite(v) ? String(v) : '-');

function sampleSafe(m) {
  if (!m) return null;
  const o = {};
  for (const [k, v] of Object.entries(m)) o[k] = v === Infinity ? 'Infinity' : v;
  return o;
}

function sourceHash() {
  const files = ['bridge/cli.js','bridge/backends/sim.js','bridge/backends/replay.js','bridge/lib/metrics.js',
    'bridge/lib/protocol.js','bridge/lib/config.js','bridge/lib/store.js','configs/bridge.example.json','bridge/lib/diagnostics.js','bridge/lib/sim-options.js','bridge/lib/sim-controller.js','bridge/lib/reports.js'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(readFileSync(presolve(paths.root, file)));
  return hash.digest('hex');
}

function table(rows) {
  if (!rows.length) return '(空)';
  const cols = Object.keys(rows[0]);
  const cells = rows.map((r) => cols.map((c) => String(r[c] ?? '')));
  const w = cols.map((c, i) => Math.max(visualWidth(c), ...cells.map((r) => visualWidth(r[i]))));
  const line = (arr) => arr.map((s, i) => s + ' '.repeat(Math.max(0, w[i] - visualWidth(s)))).join('  ');
  return [line(cols), w.map((n) => '-'.repeat(n)).join('  '), ...cells.map(line)].join('\n');
}
// 中文列名按 2 格宽计算，保证终端对齐
const visualWidth = (s) => [...String(s)].reduce((n, ch) => n + (/[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1), 0);

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
