/**
 * Compute control-response metrics from telemetry. Regulation overshoot uses
 * the reverse peak relative to the initial error; tracking uses the forward peak.
 */

const O = {
  settleBand: 0.02, // 进入 ±2% 阶跃幅值带
  tolFloor: 0.1, // 容差地板（度）：仿真绝对容差
  ssWindow: 0.3, // 末段 30% 用于稳态值
  headWindow: 0.05, // 首段 5% 用于初始值
  minSamples: 20,
  settleHoldMs: 300, // 末尾须有至少 300ms 的持续带内观测，避免单点宣称收敛
  fallLimitDeg: 50, // 仿真角度终止阈值
};

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/**
 * 代价函数的权重（可被 configs/bridge.*.json 的 cost 段覆盖）
 * 默认值必须与 `configs/bridge.example.json` 的 cost 段保持一致。
 */
export const COST_WEIGHTS = { overshoot: 0.4, settling: 0.3, ssErr: 0.2, energy: 0.1 };

/**
 * 代价函数各项的归一化常数（把不同量纲压到 ~[0,1] 后加权）
 *   overshoot  归一化到 50%（超调 0.5 及以上记满分惩罚）
 *   settlingMs 归一化到 2000 ms
 *   ssErr      以阶跃幅值为分母（与幅值无关，便于跨工况比较）
 *   energy     归一化到 20000（Σ control²·Δt 的经验量级）
 */
export const COST_NORM = { overshoot: 0.5, settlingMs: 2000, energy: 2e4 };
const NORM = COST_NORM;

export function computeMetrics(samples, opts = {}) {
  const o = { ...O, ...opts };
  const n = samples?.length ?? 0;
  if (!Number.isInteger(o.minSamples) || o.minSamples < 2 ||
      !['settleBand','tolFloor','settleHoldMs','fallLimitDeg'].every(k => Number.isFinite(o[k]) && o[k] >= 0) ||
      o.fallLimitDeg <= 0 || o.fallLimitDeg > 50 ||
      !['ssWindow','headWindow'].every(k => Number.isFinite(o[k]) && o[k] > 0 && o[k] <= 1))
    return blank('指标配置非法', n);
  const W = { ...COST_WEIGHTS, ...(o.weights ?? {}) };
  if (!Object.keys(COST_WEIGHTS).every(k => Number.isFinite(W[k]) && W[k] >= 0) ||
      Object.keys(COST_WEIGHTS).reduce((s,k) => s + W[k], 0) <= 0) return blank('指标权重非法', n);
  if (!Array.isArray(samples)) return blank('样本必须是数组', n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!s || ['ms', 'angle', 'target', 'out'].some(k => !Number.isFinite(s[k])))
      return blank(`第 ${i + 1} 个样本包含非法数字`, n);
    if (s.ms < 0 || (i && s.ms <= samples[i - 1].ms)) return blank('样本时间戳必须非负且严格递增', n);
    if (s.target !== samples[0].target) return blank('单次指标计算要求 target 保持不变', n);
  }
  const termination = opts.termination ?? samples?.termination;
  if (termination?.reason === 'fall') {
    const m = blank(`仿真摔倒：|angle|=${termination.angleDeg}° at ${termination.atMs}ms`, n);
    m.termination = termination;
    m.peakAbs = Number.isFinite(termination.angleDeg) ? Math.abs(termination.angleDeg) : null;
    return m;
  }

  const observedPeak = samples.reduce((peak, s) => Math.max(peak, Math.abs(s.angle)), 0);
  if (observedPeak > o.fallLimitDeg) {
    const m = blank(`超出摔倒阈值 |angle|=${observedPeak.toFixed(1)}° > ${o.fallLimitDeg}°`, n);
    m.peakAbs = observedPeak;
    return m;
  }
  if (n < o.minSamples) return blank(`样本不足（${n} < ${o.minSamples}）`, n);

  const y = samples.map((s) => s.angle);
  const u = samples.map((s) => Number.isFinite(s.out) ? s.out : 0);
  const target = samples[n - 1].target;
  const t0 = samples[0].ms;
  const t1 = samples[n - 1].ms;
  const dtSec = (t1 - t0) / Math.max(1, n - 1) / 1000;

  const peakAbs = observedPeak;

  // ---- 基准量 ----
  const head = Math.max(1, Math.floor(n * o.headWindow));
  const tailStart = Math.floor(n * (1 - o.ssWindow));
  const y0 = mean(y.slice(0, head));
  const ss = mean(y.slice(tailStart));
  const step = target - y0;
  const absStep = Math.abs(step);

  // ---- 超调（调节问题用反向峰值）----
  let overshoot;
  if (absStep > 1e-6) {
    let hi = -Infinity, lo = Infinity;
    for (const v of y) { if (v > hi) hi = v; if (v < lo) lo = v; }
    overshoot = step > 0
      ? Math.max(0, (hi - target) / absStep)
      : Math.max(0, (target - lo) / absStep);
  } else {
    // 目标≈初始值（纯抗扰工况）：用暂态后的最大偏离 / 初始偏离
    let dev = 0;
    for (let i = head; i < n; i++) {
      const d = Math.abs(y[i] - target);
      if (d > dev) dev = d;
    }
    overshoot = dev;
  }

  // ---- 调节时间：从此点起永远留在容差带内 ----
  const tol = Math.max(o.settleBand * absStep, o.tolFloor);
  let settleIdx = -1;
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (let j = i; j < n; j++) {
      if (Math.abs(y[j] - target) > tol) { ok = false; break; }
    }
    if (ok) { settleIdx = i; break; }
  }
  if (settleIdx >= 0 && t1 - samples[settleIdx].ms < o.settleHoldMs) settleIdx = -1;
  const settlingMs = settleIdx < 0 ? Infinity : samples[settleIdx].ms - t0;

  // ---- 振荡次数：首次穿越目标线之后的穿越次数 ----
  let firstCross = -1;
  for (let i = Math.max(1, head); i < n; i++) {
    if ((y[i - 1] - target) * (y[i] - target) <= 0) { firstCross = i; break; }
  }
  let osc = 0;
  if (firstCross > 0) {
    for (let i = firstCross + 1; i < n; i++) {
      if ((y[i - 1] - target) * (y[i] - target) < 0) osc++;
    }
  }

  // ---- 控制能量 ----
  let energy = 0;
  // 左端零阶保持：每个输出仅积分到下一采样点，最后一个点没有额外时长。
  for (let i = 0; i < n - 1; i++) energy += u[i] * u[i] * (samples[i + 1].ms - samples[i].ms) / 1000;

  const ssErr = ss - target;
  const converged = settleIdx >= 0 && overshoot <= 0.3 && Math.abs(ssErr) <= tol;

  // ---- 代价函数 J（越小越好）----
  //  v2 修正：归一化常数与权重全部显式命名并随结果一起返回，

  const j =
    W.overshoot * Math.min(overshoot / NORM.overshoot, 1) +
    W.settling * Math.min(settlingMs / NORM.settlingMs, 1) +
    W.ssErr * Math.min(Math.abs(ssErr) / Math.max(absStep, 1), 1) +
    W.energy * Math.min(energy / NORM.energy, 1);

  return {
    ok: true, fail: false, converged,
    n, dtMs: Number((dtSec * 1000).toFixed(2)),
    target: round(target), y0: round(y0), step: round(step), ss: round(ss),
    overshoot: round(overshoot), settlingMs: settleIdx < 0 ? Infinity : Math.round(settlingMs),
    ssErr: round(ssErr), osc, energy: Math.round(energy), peakAbs: round(peakAbs),
    j: round(j),
    jWeights: W,          // 本次 J 实际使用的权重
    jNorm: NORM,          // 本次 J 实际使用的归一化常数
    tol: round(tol),      // 本次调节时间判据使用的容差带
    settleHoldMs: o.settleHoldMs,
  };
}

function blank(reason, n) {
  return {
    ok: false, fail: true, converged: false, reason,
    n, overshoot: NaN, settlingMs: NaN, ssErr: NaN, osc: NaN, energy: NaN, j: Infinity,
  };
}

const round = (v) => (Number.isFinite(v) ? Number(v.toFixed(4)) : v);

export const __internal = O;
