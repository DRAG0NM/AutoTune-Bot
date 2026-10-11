/**
 * Persist telemetry and append-only run records.
 * last_good.json stores gains together with their verification status.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { FIRMWARE_DEFAULTS, TUNABLE, clampParam } from './protocol.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const paths = {
  root: ROOT,
  runs: process.env.AUTOTUNE_RUNS_DIR ? resolve(process.env.AUTOTUNE_RUNS_DIR) : resolve(ROOT, 'runs'),
  state: process.env.AUTOTUNE_STATE_DIR ? resolve(process.env.AUTOTUNE_STATE_DIR) : resolve(ROOT, 'state'),
};

function ensure(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const CSV_HEADER = 'ms,angle,target,out,spdL,spdR,errInt';

export function writeRunCsv(tag, samples) {
  if (tag && !/^[a-zA-Z0-9_-]{1,80}$/.test(tag)) throw new Error('tag 只允许 1–80 个字母、数字、下划线、短横线');
  ensure(paths.runs);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `run_${stamp}_${randomUUID().slice(0, 8)}${tag ? '_' + tag : ''}.csv`;
  const body = samples.map((s) => [s.ms, s.angle, s.target, s.out, s.spdL, s.spdR, s.errInt].join(',')).join('\n');
  writeFileSync(resolve(paths.runs, name), `${CSV_HEADER}\n${body}\n`, 'utf8');
  return name;
}

export function appendIndex(record) {
  ensure(paths.runs);
  appendFileSync(resolve(paths.runs, 'index.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
}

export function readIndex() {
  const p = resolve(paths.runs, 'index.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l,i) => { try { return JSON.parse(l); } catch { throw new Error(`实验索引第 ${i+1} 行损坏，停止读取`); } });
}

const initialGood = () => Object.fromEntries(TUNABLE.map((k) => [k, FIRMWARE_DEFAULTS[k]]));

export function loadLastGoodState() {
  const p = resolve(paths.state, 'last_good.json');
  if (!existsSync(p)) return { status: 'unverified', source: 'firmware-defaults', gains: initialGood() };
  try {
    const stored = JSON.parse(readFileSync(p, 'utf8'));
    const envelope = stored && typeof stored === 'object' && stored.schema === 1 ? stored : null;
    if (envelope && !['verified', 'unverified'].includes(envelope.status))
      return { status: 'invalid', source: 'state-file', gains: initialGood() };
    const gains = envelope?.gains ?? stored;
    if (!gains || typeof gains !== 'object' || Array.isArray(gains) || !TUNABLE.every(k => Number.isFinite(gains[k])))
      return { status: 'invalid', source: 'state-file', gains: initialGood() };
    const checked = Object.fromEntries(TUNABLE.map(k => [k, clampParam(k, gains[k]).value]));
    const valid = TUNABLE.every(k => checked[k] === gains[k]);
    if (!valid) return { status: 'invalid', source: 'state-file', gains: initialGood() };
    if (!envelope || envelope.status !== 'verified')
      return { status: 'unverified', source: envelope ? 'unverified-state-file' : 'legacy-state-file', gains: checked };
    if (typeof envelope.verifiedAt !== 'string' || !Number.isFinite(Date.parse(envelope.verifiedAt)))
      return { status: 'invalid', source: 'state-file', gains: initialGood() };
    return { status: 'verified', source: 'verified-state-file', gains: checked, verifiedAt: envelope.verifiedAt ?? null };
  } catch {
    return { status: 'invalid', source: 'state-file', gains: initialGood() };
  }
}

export function loadLastGood() {
  return loadLastGoodState().gains;
}

export function saveLastGood(gains, { verified = false, verifiedAt = new Date().toISOString() } = {}) {
  if (verified && (!Number.isFinite(Date.parse(verifiedAt)) || typeof verifiedAt !== 'string'))
    throw new Error('已验证状态必须包含有效 verifiedAt 时间戳');
  ensure(paths.state);
  const keep = {};
  for (const k of TUNABLE) {
    if (!Number.isFinite(gains[k])) throw new Error(`last-good 参数 ${k} 缺失或无效`);
    const checked = clampParam(k, gains[k]);
    if (checked.clamped) throw new Error(`last-good 参数 ${k} 超出范围`);
    keep[k] = checked.value;
  }
  writeFileSync(resolve(paths.state, 'last_good.json'), JSON.stringify({
    schema: 1, status: verified ? 'verified' : 'unverified', gains: keep,
    verifiedAt: verified ? verifiedAt : null,
  }, null, 2), 'utf8');
  return keep;
}
