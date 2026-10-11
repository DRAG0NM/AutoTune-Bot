/**
 * Load defaults, example configuration, then local overrides.
 * Keys starting with _ are documentation; parameter limits must match the protocol.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from './store.js';
import { PARAM_LIMITS } from './protocol.js';

export const DEFAULT_CONFIG = {
  serial: { port: 'COM5', baud: 115200 },
  trial: { durationMs: 3000, gapMs: 3000 },
  safety: { heartbeatMs: 100, watchdogMs: 500, settleMs: 250,
    serialAckTimeoutMs: 500, serialMinCoverageFraction: 0.8, serialMaxSampleGapMs: 250, serialMaxStartTelemetryDelayMs: 500 },
  metrics: { settleBand: 0.02, tolFloor: 0.1, ssWindow: 0.3, headWindow: 0.05, fallLimitDeg: 50, minSamples: 20, settleHoldMs: 300 },
  cost: { wOvershoot: 0.4, wSettling: 0.3, wSsErr: 0.2, wEnergy: 0.1 },
  agents: { maxRounds: 25, stopAfterNoImprovement: 3, repeatPerParamSet: 2 },
};

/** 深合并：只合并普通对象，数组与标量直接覆盖；忽略 `_` 开头的注释键 */
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith('_')) continue;
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(base[k] ?? {}, v) : v;
  }
  return out;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('顶层必须是对象');
    return value;
  } catch (e) {
    throw new Error(`配置文件解析失败 ${file}: ${e.message}`);
  }
}

/** 校验配置里的参数限幅表与代码里的 PARAM_LIMITS 完全一致 */
function checkParamLimits(cfg) {
  const table = cfg.safety?.paramLimits;
  if (!table) return [];
  const problems = [];
  for (const [name, range] of Object.entries(table)) {
    const code = PARAM_LIMITS[name];
    if (!code) { problems.push(`配置里的参数「${name}」在代码中不存在`); continue; }
    if (!Array.isArray(range) || range.length !== 2 || code[0] !== range[0] || code[1] !== range[1]) {
      problems.push(`参数「${name}」限幅不一致：配置 [${range}] vs 代码 [${code}]`);
    }
  }
  for (const name of Object.keys(PARAM_LIMITS)) {
    if (!(name in table)) problems.push(`代码里有参数「${name}」但配置里没列`);
  }
  if (problems.length) {
    throw new Error(
      '配置与代码的参数限幅表不一致（两侧必须逐值相同，否则会出现"以为下发成功、其实被截断"的静默错误）：\n  - ' +
      problems.join('\n  - ')
    );
  }
  return [];
}

let cached = null;

/** @returns {{config: object, source: string}} */
export function loadConfig() {
  if (cached) return cached;

  const example = resolve(paths.root, 'configs/bridge.example.json');
  const local = resolve(paths.root, 'configs/bridge.local.json');

  let cfg = DEFAULT_CONFIG;
  const used = [];

  const fromExample = readJson(example);
  if (fromExample) { cfg = merge(cfg, fromExample); used.push('bridge.example.json'); }

  const fromLocal = readJson(local);
  if (fromLocal) { cfg = merge(cfg, fromLocal); used.push('bridge.local.json'); }

  // Windows/WSL 启动脚本可临时指定串口，命令行 --port 仍拥有更高优先级。
  if (process.env.PID_PORT) {
    cfg = merge(cfg, { serial: { port: process.env.PID_PORT } });
    used.push('PID_PORT');
  }

  checkParamLimits(cfg);
  for (const [section, keys] of Object.entries({
    trial: ['durationMs','gapMs'], safety: ['heartbeatMs','watchdogMs','settleMs',
      'serialAckTimeoutMs','serialMinCoverageFraction','serialMaxSampleGapMs','serialMaxStartTelemetryDelayMs'],
    metrics: ['settleBand','tolFloor','ssWindow','headWindow','fallLimitDeg','minSamples','settleHoldMs'],
    cost: ['wOvershoot','wSettling','wSsErr','wEnergy'],
    agents: ['maxRounds','stopAfterNoImprovement','repeatPerParamSet'],
  })) {
    for (const key of keys) if (!Number.isFinite(cfg[section]?.[key]) || cfg[section][key] < 0)
      throw new Error(`配置 ${section}.${key} 必须是非负有限数字`);
  }
  if (cfg.trial.durationMs < 1000 || cfg.trial.durationMs > 4000) throw new Error('配置 trial.durationMs 必须在 1000–4000ms');
  if (cfg.metrics.ssWindow <= 0 || cfg.metrics.ssWindow > 1 || cfg.metrics.headWindow <= 0 || cfg.metrics.headWindow > 1)
    throw new Error('配置采样窗口比例必须在 (0,1]');
  if (cfg.metrics.fallLimitDeg <= 0 || cfg.metrics.fallLimitDeg > 50) throw new Error('配置摔倒阈值必须在 (0,50]');
  if (cfg.safety.heartbeatMs <= 0 || cfg.safety.heartbeatMs >= cfg.safety.watchdogMs)
    throw new Error('心跳周期必须为正且小于看门狗阈值');
  if (cfg.safety.serialMinCoverageFraction <= 0 || cfg.safety.serialMinCoverageFraction > 1 ||
      cfg.safety.serialAckTimeoutMs <= 0 || cfg.safety.serialMaxSampleGapMs <= 0 || cfg.safety.serialMaxStartTelemetryDelayMs <= 0)
    throw new Error('serial 遥测完整性阈值无效');
  if (!Number.isInteger(cfg.metrics.minSamples) || cfg.metrics.minSamples < 2) throw new Error('minSamples 必须是至少 2 的整数');
  if (Object.values(cfg.agents).some(v => !Number.isInteger(v) || v <= 0)) throw new Error('agents 预算必须是正整数');
  if (['wOvershoot','wSettling','wSsErr','wEnergy'].reduce((s,k)=>s+cfg.cost[k],0) <= 0)
    throw new Error('代价权重不能全部为零');

  const source = used.map((name) => name === 'PID_PORT' ? '环境变量 PID_PORT' : `configs/${name}`).join(' + ');
  cached = { config: cfg, source: source || '内置默认值' };
  return cached;
}

/** 代价函数的权重（供 metrics.js 使用） */
export function costWeights(cfg = loadConfig().config) {
  return {
    overshoot: cfg.cost.wOvershoot,
    settling: cfg.cost.wSettling,
    ssErr: cfg.cost.wSsErr,
    energy: cfg.cost.wEnergy,
  };
}
