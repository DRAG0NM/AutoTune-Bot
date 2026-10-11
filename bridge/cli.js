#!/usr/bin/env node
/**
 * PID experiment CLI for simulation, CSV replay and serial execution.
 * Serial operations require command acknowledgements and report unknown device state.
 */

import { isAbsolute, resolve as presolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  parseGainList, FIRMWARE_DEFAULTS, TUNABLE, ALLOWED_CMDS,
  encodeCmd, encodeSlider, parseTelemetry,
} from './lib/protocol.js';
import { computeMetrics } from './lib/metrics.js';
import { diagnose } from './lib/diagnostics.js';
import { loadConfig, costWeights } from './lib/config.js';
import { writeRunCsv, appendIndex, readIndex, loadLastGood, loadLastGoodState, saveLastGood, paths } from './lib/store.js';
import { runSim, SIM_PRESETS, SIM_MODEL_VERSION } from './backends/sim.js';
import { runReplay } from './backends/replay.js';
import {normalizeSimProfile,simConditions} from './lib/sim-options.js';
import {normalizeSimController} from './lib/sim-controller.js';
import { elapsedDeviceMs } from './backends/serial.js';

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
    if (['json','help','dry-run'].includes(key)) { f[key] = true; continue; }
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
    case 'ports': return cmdPorts();
    case 'set': return cmdSet();
    case 'start': return cmdStart();
    case 'rollback': return cmdRollback();
    case 'stop': return cmdStop();
    case 'trial': return cmdTrial();
    case 'selftest': return cmdSelftest();
    case 'runs': return cmdRuns();
    default: usage(1);
  }
}

function usage(code = 0) {
  console.log(`PID-Bridge —— 平衡车 PID 自动整定实验台

用法:
  node bridge/cli.js params
  node bridge/cli.js ports
  node bridge/cli.js set AngleKp 5.5 [--port COM5] [--baud 115200]
  node bridge/cli.js start [--port COM5]       # 确认后维持心跳；Ctrl+C 退出并尝试 Stop
  node bridge/cli.js stop [--port COM5]
  node bridge/cli.js rollback [--port COM5]
  node bridge/cli.js trial --backend sim [--gains "AngleKp=6,AngleKi=0,AngleKd=16"] [--dur 3000] [--json]
  node bridge/cli.js trial --backend replay --csv testdata/sample_step_response.csv --json
  node bridge/cli.js trial --backend serial --port COM5 --gains "AngleKp=<已验证值>,AngleKi=<已验证值>,AngleKd=<已验证值>" --json
  node bridge/cli.js selftest [--json]
  node bridge/cli.js runs

后端说明:
  sim     确定性倒立摆仿真（无必需依赖）
  replay  原始 CSV 回放（不插值，不操作设备）
  serial  STM32 串口（需按需安装 serialport）

串口执行约束:
  · set / rollback / trial 先要求 Stop 确认；缺确认时拒绝继续写参数
  · trial 要求 Start 确认后才采集，结束时尝试 Stop；设备物理状态仍需读回
  · 参数只允许改 ${TUNABLE.join(' / ')}（见 lib/protocol.js 的 TUNABLE 白名单）
  · 配置来自 configs/bridge.example.json（可被 bridge.local.json / PID_PORT 覆盖），用 params 查看来源`);
  process.exit(code);
}

function cmdParams() {
  const { config: cfg, source } = loadConfig();
  const state = loadLastGoodState();
  const good = state.gains;
  const rows = TUNABLE.map((k) => ({ 参数: k, 固件默认: FIRMWARE_DEFAULTS[k], 'last-known-good': good[k] }));
  emit(
    { lastGood: good, lastGoodStatus: state.status, lastGoodSource: state.source,
      firmwareDefaults: FIRMWARE_DEFAULTS, tunable: TUNABLE, configSource: source, config: cfg },
    `${table(rows)}\n\n可调参数白名单 : ${TUNABLE.join(', ')}\n配置来源       : ${source}\n实验时长默认   : ${cfg.trial.durationMs} ms\n代价权重       : ${JSON.stringify(cfg.cost)}`
  );
}

async function cmdPorts() {
  const { listPorts } = await import('./backends/serial.js');
  try {
    const ports = await listPorts();
    emit({ ports }, ports.length ? ports.map((p) => `${p.path}\t${p.manufacturer}`).join('\n') : '未发现串口（检查 CH340 驱动/接线）');
  } catch (e) {
    emit({ error: e.message }, `错误：${e.message}`);
  }
}

async function cmdSet() {
  const [key, value] = positional;
  if (!key || value === undefined) usage(1);
  const { config: cfg } = loadConfig();
  const { sendParams } = await import('./backends/serial.js');
  const gains = { [key]: Number(value) };
  try {
    // sendParams 会先发 [cmd,Stop,1]，写完不自动启动
    const result = await sendParams({ port: flags.port ?? cfg.serial.port, baud: Number(flags.baud ?? cfg.serial.baud),
      gains, settleMs: cfg.safety.settleMs, ackTimeoutMs: cfg.safety.serialAckTimeoutMs });
    emit(
      { hostStatus: 'complete', set: gains, parameterAcks: result.parameterAcks,
        stopAcknowledgement: result.stopAcknowledgement, deviceState: result.deviceState },
      `主机已收到 Stop 和 ${key} 的固件回执；设备物理状态仍未知。`
    );
  } catch (e) {
    emit({ ok: false, hostStatus: 'error', deviceState: 'unknown', error: e.message }, `失败：${e.message}；设备状态未知。`);
    process.exitCode = 1;
  }
}

async function cmdStart() {
  const { config: cfg } = loadConfig();
  const { startBalance, waitForSerialStop } = await import('./backends/serial.js');
  try {
    const session = await startBalance({
      port: flags.port ?? cfg.serial.port,
      baud: Number(flags.baud ?? cfg.serial.baud),
      heartbeatMs: cfg.safety.heartbeatMs,
      settleMs: cfg.safety.settleMs,
      ackTimeoutMs: cfg.safety.serialAckTimeoutMs,
    });
    if (!flags.json) emit({ hostStatus: 'active', running: null, deviceState: session.deviceState,
      startAcknowledgement: session.startAcknowledgement }, 'Start 已获设备命令回执，主机持续发送心跳；按 Ctrl+C 结束主机心跳，设备物理状态仍未知。');
    const result = await waitForSerialStop(session);
    const failed = result.signal === 'SERIAL_ERROR' || Boolean(result.cleanup.error) || !result.cleanup.closeStatus?.closed;
    emit({ hostStatus: failed ? 'error' : 'stopped', signal: result.signal, error: result.error,
      startAcknowledgement: session.startAcknowledgement, cleanup: result.cleanup, deviceState: result.deviceState },
    `${failed ? '串口故障' : '主机心跳已结束'}；清理结果已记录，设备状态未知。`);
    process.exitCode = failed ? 1 : result.signal === 'SIGTERM' ? 143 : 130;
  } catch (e) {
    emit({ ok: false, hostStatus: 'error', deviceState: 'unknown', error: e.message }, `失败：${e.message}；设备状态未知。`);
    process.exitCode = 1;
  }
}

async function cmdRollback() {
  const { config: cfg } = loadConfig();
  const state = loadLastGoodState();
  if (state.status !== 'verified') {
    emit({ hostStatus: 'refused', rolledBack: false, deviceState: 'unknown',
      lastGoodStatus: state.status, lastGoodSource: state.source,
      error: '没有经设备验证的 last-good 参数；拒绝使用默认值或旧格式状态执行回滚。' },
    '回滚已拒绝：没有经设备验证的 last-good 参数，设备状态未知。');
    process.exitCode = 1;
    return;
  }
  const good = state.gains;
  const { sendParams } = await import('./backends/serial.js');
  try {
    const result = await sendParams({ port: flags.port ?? cfg.serial.port, baud: Number(flags.baud ?? cfg.serial.baud),
      gains: good, settleMs: cfg.safety.settleMs, ackTimeoutMs: cfg.safety.serialAckTimeoutMs });
    emit(
      { hostStatus: 'complete', parameterAcks: result.parameterAcks, rolledBackTo: good,
        rolledBack: false, stopAcknowledgement: result.stopAcknowledgement, deviceState: result.deviceState },
      `回滚参数已得到 Stop 和逐项写入回执：${JSON.stringify(good)}。设备物理状态仍未知。`
    );
  } catch (e) {
    emit({ ok: false, hostStatus: 'error', deviceState: 'unknown', error: e.message }, `失败：${e.message}；设备状态未知。`);
    process.exitCode = 1;
  }
}

async function cmdStop() {
  const { config: cfg } = loadConfig();
  const { emergencyStop } = await import('./backends/serial.js');
  try {
    const result = await emergencyStop({ port: flags.port ?? cfg.serial.port, baud: Number(flags.baud ?? cfg.serial.baud) });
    emit({ hostStatus: 'sent', stopAttempts: result.attempts,
      acknowledgement: result.acknowledgement, deviceState: result.deviceState },
    '已发送 5 次 Stop 并完成串口排空；固件没有 Stop 回执，设备状态未知。');
  } catch (e) {
    emit({ ok: false, hostStatus: 'error', deviceState: 'unknown', error: e.message }, `失败：${e.message}；设备状态未知。`);
    process.exitCode = 1;
  }
}

async function cmdTrial() {
  const { config: cfg, source: cfgSource } = loadConfig();
  const backend = flags.backend ?? 'sim';
  const durationMs = Number(flags.dur ?? cfg.trial.durationMs);
  const target = Number(flags.target ?? 0);
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 4000)
    throw new Error('trial 时长必须是 1000–4000ms 的有限数字');
  if (!Number.isFinite(target)) throw new Error('target 必须是有限数字');
  const allowed = ['backend','dur','target','gains','json','x0','seed','disturb','csv','port','baud',
    'dry-run','fallLimit','tag','campaign','reason','parent','purpose','plan','sim-profile','sim-controller'];
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`未知 trial 选项: --${key}`);
  for (const key of ['backend','dur','target','gains','x0','seed','disturb','csv','port','baud','fallLimit','tag','campaign','reason','parent','purpose','plan','sim-profile','sim-controller'])
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
  const good = loadLastGood();
  const gains = backend === 'replay' ? null : parseGainList(flags.gains, good);
  if (backend === 'serial' && !flags['dry-run']) {
    const provided = new Set(String(flags.gains ?? '').split(',').map((pair) => pair.split('=')[0]?.trim()).filter(Boolean));
    const missing = TUNABLE.filter((name) => !provided.has(name));
    if (missing.length) throw new Error(`serial trial 必须显式提供全部可调参数 ${TUNABLE.join(', ')}；禁止用默认/未验证值代替车上状态`);
  }
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
      if(purpose==='robustness' && !search.some(r=>!r.metrics.fail && JSON.stringify(r.gains)===JSON.stringify(gains))) throw Error('验证候选必须来自已测非摔倒搜索点');
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
  } else if (backend === 'serial') {
    const serialPort = flags.port ?? cfg.serial.port;
    if (!serialPort) throw new Error('serial 后端没有可用串口：请配置 serial.port 或传 --port COMx');
    if (flags['dry-run']) {
      samples = [];
      meta.dryRun = true;
      meta.port = serialPort;
    } else {
      const { runSerial } = await import('./backends/serial.js');
      const r = await runSerial({
        port: serialPort,
        baud: Number(flags.baud ?? cfg.serial.baud),
        gains,
        durationMs,
        heartbeatMs: cfg.safety.heartbeatMs,
        settleMs: cfg.safety.settleMs,
        ackTimeoutMs: cfg.safety.serialAckTimeoutMs,
        minSamples: cfg.metrics.minSamples,
        minCoverageFraction: cfg.safety.serialMinCoverageFraction,
        maxSampleGapMs: cfg.safety.serialMaxSampleGapMs,
        maxStartTelemetryDelayMs: cfg.safety.serialMaxStartTelemetryDelayMs,
        fallLimitDeg: fallLimit,
      });
      samples = r.samples;
      meta.timedOut = r.timedOut;
      meta.port = serialPort;
      meta.interrupted = r.interrupted;
      meta.hostStatus = r.hostStatus;
      meta.deviceState = r.deviceState;
      meta.commandStatus = r.commandStatus;
      meta.parameterAcks = r.parameterAcks;
      meta.telemetry = r.telemetry;
      meta.serialIssues = r.issues;
      meta.serialError = r.error;
      if (r.interrupted) process.exitCode = r.signal === 'SIGTERM' ? 143 : 130;
      else if (r.hostStatus !== 'complete') process.exitCode = 1;
    }
  } else {
    throw new Error(`未知后端: ${backend}`);
  }

  const metrics = computeMetrics(samples, {
    ...cfg.metrics,
    termination: meta.sim?.termination,
    fallLimitDeg: fallLimit,
    weights: costWeights(cfg),
  });

  //  安全语义：只有真车验证过的收敛参数才允许提升为 last-known-good。
  //    仿真/回放里"跑得好"不等于真车安全 ; 绝不能把仿真参数当成真车的回滚目标。
  const hardwareVerified = backend === 'serial' && !meta.dryRun && !meta.interrupted &&
    !meta.timedOut && meta.deviceState === 'verified' && meta.telemetry?.valid === true;
  const promoted = metrics.ok && metrics.converged && hardwareVerified;
  if (promoted) saveLastGood(gains, { verified: true });

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
  record.decisionEligible = backend !== 'serial' ? metrics.ok && metrics.converged : hardwareVerified && metrics.ok && metrics.converged;
  appendIndex(record);

  const serialStateUnknown = backend === 'serial' && !meta.dryRun && meta.deviceState !== 'verified';
  const invalidSerialTelemetry = backend === 'serial' && !meta.dryRun && meta.telemetry?.valid !== true;
  const verdict = serialStateUnknown ? '状态未知' : invalidSerialTelemetry ? '遥测无效' :
    metrics.fail ? '失败' : metrics.converged ? '收敛' : '未收敛';
  const human = [
    `后端      : ${backend}${meta.csv ? ' (' + meta.csv + ')' : ''}${meta.port ? '  串口: ' + meta.port : ''}   配置来源: ${cfgSource}`,
    `参数      : ${JSON.stringify(gains)}  (来源: ${flags.gains ? '命令行' : 'last-known-good'})`,
    `判定      : ${verdict}`,
    `超调      : ${fmt(metrics.overshoot)}  调节时间: ${fmt(metrics.settlingMs)} ms  稳态误差: ${fmt(metrics.ssErr)}`,
    `振荡次数  : ${fmt(metrics.osc)}   控制能量: ${fmt(metrics.energy)}   J: ${fmt(metrics.j)}`,
    `设备状态  : ${meta.deviceState ?? (backend === 'serial' ? '状态未知' : '不适用')}`,
    `数据资格  : ${backend === 'serial' ? (meta.telemetry?.valid ? '遥测完整；设备状态未知，不能作为候选' : '遥测不完整，不能作为候选') : '按仿真/回放规则评价'}`,
    `参数提升  : ${promoted ? '已写入 last-known-good（设备已验证）' : '否（设备状态未确认）'}`,
    `原始数据  : runs/${csvName ?? '(无)'}`,
  ].join('\n');

  const verdictCode = serialStateUnknown ? 'state_unknown' : invalidSerialTelemetry ? 'invalid_telemetry' :
    metrics.converged ? 'converged' : metrics.fail ? 'failed' : 'not_converged';
  emit({ ...record, verdict: verdictCode }, human);
}

async function cmdSelftest() {
  // v2：自检也走配置文件，保证"自检通过的值"与"真跑时的值"是同一套口径
  const { config: cfg, source: cfgSource } = loadConfig();
  const metricOpts = { ...cfg.metrics, weights: costWeights(cfg) };

  const cases = [];
  const protocolChecks = {};
  try {
    for (const action of ALLOWED_CMDS) {
      protocolChecks[`cmd:${action}`] = encodeCmd(action) === `[cmd,${action},1]`;
    }
    protocolChecks['slider:clamp'] = encodeSlider('AngleKp', 999).frame === '[slider,AngleKp,20]';
    protocolChecks['telemetry:parse'] = parseTelemetry('T,123,1.2,0,3,4,5,6')?.ms === 123;
    protocolChecks['device-tick:wrap'] = elapsedDeviceMs(2, 0xFFFFFFFE) === 4;
  } catch {
    for (const action of ALLOWED_CMDS) protocolChecks[`cmd:${action}`] = false;
    protocolChecks['slider:clamp'] = false;
    protocolChecks['telemetry:parse'] = false;
    protocolChecks['device-tick:wrap'] = false;
  }
  const protocolPass = Object.values(protocolChecks).every(Boolean);
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

  const allPass = protocolPass && rows.every((r) => r.判定 === 'PASS');
  await Promise.resolve(); // 保持 async 形状
  if (flags.out) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(flags.out), { recursive: true });
    writeFileSync(flags.out, JSON.stringify({ ts: new Date().toISOString(), allPass, protocol: protocolChecks, cases }, null, 2), 'utf8');
  }
  emit(
    { allPass, protocol: protocolChecks, cases },
    `${table(rows)}\n\n协议自检: ${protocolPass ? 'PASS' : 'FAIL'} (${Object.entries(protocolChecks).map(([k, v]) => `${k}=${v ? 'PASS' : 'FAIL'}`).join(', ')})\n总体: ${allPass ? 'PASS —— 协议与正常/边界/失败样例均符合预期' : 'FAIL —— 存在不符合预期的样例'}`
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
  const files = ['bridge/cli.js','bridge/backends/sim.js','bridge/backends/replay.js','bridge/backends/serial.js','bridge/lib/metrics.js',
    'bridge/lib/protocol.js','bridge/lib/config.js','bridge/lib/store.js','configs/bridge.example.json','bridge/lib/diagnostics.js','bridge/lib/sim-options.js','bridge/lib/sim-controller.js'];
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
