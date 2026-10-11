#!/usr/bin/env node
/**
 * Exhaustive simulation grid over Kp and Kd for a fixed Ki and test condition.
 * Reports the lowest finite J among converged candidates.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSim } from '../bridge/backends/sim.js';
import { computeMetrics } from '../bridge/lib/metrics.js';
import { loadConfig, costWeights } from '../bridge/lib/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const options = new Set(['kps','kds','ki','dur','x0','seed','out']);
const seen = new Set();
for (let i=0;i<argv.length;i++) {
  const key=argv[i].slice(2);
  if (!argv[i].startsWith('--') || (!options.has(key) && key!=='json') || seen.has(key)) throw new Error('未知或重复网格选项');
  seen.add(key);
  if (key!=='json' && (!argv[++i] || argv[i].startsWith('--'))) throw new Error(`--${key} 缺少值`);
}
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] ?? true : d; };
const has = (n) => argv.includes(`--${n}`);
const nums = (s, d) => {
  if (s === undefined) return d;
  const cells = String(s).split(',');
  if (cells.some(v => !v.trim() || !Number.isFinite(Number(v)))) throw new Error('网格列表含非法数字');
  return cells.map(Number);
};

const kps = nums(flag('kps'), [2, 4, 6, 8, 10, 12]);
const kds = nums(flag('kds'), [0, 4, 8, 12, 16, 20]);
const ki = Number(flag('ki', 0.1));
const dur = Number(flag('dur', 3000));
const x0 = Number(flag('x0', 3));
const seed = Number(flag('seed', 20261008));
const { config, source: configSource } = loadConfig();
if (dur<1000 || dur>4000) throw new Error('网格时长必须在 1000–4000ms');
if (![...kps,...kds,ki,dur,x0,seed].every(Number.isFinite) || !kps.length || !kds.length)
  throw new Error('网格参数必须是非空的有限数字列表');
if ([...kps,...kds].some(v=>v<0 || v>20) || ki<0 || ki>5) throw new Error('网格参数超出协议限幅');
const metricOpts = { ...config.metrics, weights: costWeights(config) };

const rows = [];
for (const kp of kps) {
  for (const kd of kds) {
    const gains = { AngleKp: kp, AngleKi: ki, AngleKd: kd };
    const m = computeMetrics(runSim({ gains, durationMs: dur, x0, seed }), metricOpts);
    rows.push({ kp, kd, fail: m.fail, converged: m.converged, overshoot: m.overshoot, settlingMs: m.settlingMs, osc: m.osc, ssErr: m.ssErr, energy: m.energy, j: m.j });
  }
}

const feasible = rows.filter((r) => !r.fail && r.converged && Number.isFinite(r.j));
const best = feasible.length ? feasible.reduce((a, b) => (b.j < a.j ? b : a)) : null;

// J 地形图（行=Kp，列=Kd；∞ 表示摔倒）
const heat = kps.map((kp) => kds.map((kd) => {
  const r = rows.find((x) => x.kp === kp && x.kd === kd);
  return r.fail ? ' ∞   ' : r.j.toFixed(2).padStart(5);
}));

const pad = (s, n) => String(s).padEnd(n);
const out = [
  `网格搜索基线  Kp×Kd=${kps.length}×${kds.length}  Ki=${ki}  时长=${dur}ms  初始角=${x0}°`,
  '',
  `J 地形（行=Kp: ${kps.join('/')}   列=Kd: ${kds.join('/')}）`,
  `        ${kds.map((k) => pad(k, 6)).join('')}`,
  ...kps.map((kp, i) => `${pad(kp, 6)}  ${heat[i].map((c) => pad(c, 6)).join('')}`),
  '',
  best ? `已测收敛候选中 J 最小: Kp=${best.kp} Kd=${best.kd} J=${best.j}` : '没有收敛候选；本轮不报告最优参数',
  `出厂默认对照  : Kp=5 Kd=5  ` + (() => {
    const d = computeMetrics(runSim({ gains: { AngleKp: 5, AngleKi: 0.1, AngleKd: 5 }, durationMs: dur, x0, seed }), metricOpts);
    return `超调=${d.overshoot}  调节=${d.settlingMs}ms  振荡=${d.osc}  J=${d.j}`;
  })(),
  `不可行点（摔倒）: ${rows.filter((r) => r.fail).length} / ${rows.length}`,
].join('\n');

if (flag('out')) {
  const p = isAbsolute(flag('out')) ? flag('out') : resolve(ROOT, flag('out'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, json({ ts: new Date().toISOString(), ki, dur, x0, seed, configSource, metricOpts, kps, kds, best, rows }), 'utf8');
}

if (has('json')) console.log(json({ best, ki, dur, x0, seed, configSource, metricOpts, rows }));
else console.log(out);

function json(value) { return JSON.stringify(value, (_k,v)=>typeof v === 'number' && !Number.isFinite(v) ? (Number.isNaN(v) ? null : String(v)) : v, 2); }
