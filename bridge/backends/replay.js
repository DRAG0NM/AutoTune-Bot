/**
 * Read CSV telemetry without interpolation or device I/O.
 * Parameter changes do not affect recorded responses.
 */

import { readFileSync } from 'node:fs';

const NUM = (v) => {
  if (v === undefined || String(v).trim() === '') throw new Error('CSV 数值缺失');
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) throw new Error(`CSV 非法数值: ${v}`);
  return n;
};

export function loadCsv(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) throw new Error(`CSV 为空: ${file}`);

  const header = lines[0].split(',').map((s) => s.trim().toLowerCase());
  if (new Set(header).size !== header.length) throw new Error('CSV 表头包含重复列');
  const need = ['ms', 'angle', 'target', 'out'];
  const idx = Object.fromEntries(need.map((k) => [k, header.indexOf(k)]));
  const missing = need.filter((k) => idx[k] < 0);
  if (missing.length) throw new Error(`CSV 缺少列: ${missing.join(', ')}（表头应含 ms,angle,target,out,spdL,spdR,errInt）`);

  const rows = lines.slice(1).map((l) => l.split(','));
  if (rows.some(r => r.length !== header.length)) throw new Error('CSV 行列数与表头不一致');
  const samples = rows.map((r) => ({
    ms: NUM(r[idx.ms]),
    angle: NUM(r[idx.angle]),
    target: NUM(r[idx.target]),
    out: NUM(r[idx.out]),
    spdL: NUM(r[header.indexOf('spdl')] ?? 0),
    spdR: NUM(r[header.indexOf('spdr')] ?? 0),
    errInt: NUM(r[header.indexOf('errint')] ?? 0),
  }));
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].ms <= samples[i - 1].ms) throw new Error('CSV 时间戳必须严格递增');
  }
  if (samples.some(s => s.ms < 0)) throw new Error('CSV 时间戳不能为负');
  // 原样保留采样点；插值重采样会隐去短暂越界并改变能量与收敛判据。
  return samples;
}

/** 回放后端永远不允许"写入";它是只读的证据通道，不发送设备命令 */
export function runReplay({ file, gains }) {
  if (gains) {

    process.stderr.write('[replay] 注意：回放后端为只读，传入的 gains 不会改变回放曲线。\n');
  }
  return loadCsv(file);
}
