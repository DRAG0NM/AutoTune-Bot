/**
 * Deterministic inverted-pendulum simulation. Uses a 10 ms control loop and
 * sampled telemetry; pressure profiles and controller variants are optional.
 */

import {normalizeSimProfile,hasSimPressure} from '../lib/sim-options.js';
export const SIM_MODEL_VERSION = 'sim-timing-2';
export const SIM_PRESSURE_VERSION = 'sim-pressure-3';

const G = 9.81;         // 重力加速度
const L = 0.15;         // 等效摆长 (m)
const FALL_DEG = 50;    // 与固件摔倒判据一致

/* Assumed plant constants, not identified from vehicle measurements.
 * Dynamics include gravity, control authority and lumped damping. */
const A_FALL = G / L;   // ≈ 65.4 (1/s²)
const B_CTRL = 20;      // deg/s² per PWM
const DAMP = 4.3;       // 1/s

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = 180 / Math.PI;

/**
 * @param {object} o
 * @param {object} o.gains    PID 参数（AngleKp/AngleKi/AngleKd/Offset）
 * @param {number} o.target   角度环目标值（度）
 * @param {number} o.durationMs 实验时长
 * @param {number} o.x0       初始角度偏差（度）
 * @param {number} o.dtMs     控制周期（固件为 10ms）
 * @param {number} o.sampleMs 遥测周期（固件改造后为 50ms → 20Hz）
 * @param {number} o.noise    角度传感器噪声幅度（度，峰峰值的一半）
 * @param {object} [o.disturbance] {atMs, impulseDegPerSec} 模拟手推扰动
 * @param {number} o.seed     随机种子
 */
export function runSim(o = {}) {
  const {
    gains = {},
    target = 0,
    durationMs = 3000,
    x0 = 3,
    dtMs = 10,
    sampleMs = 50,
    noise: legacyNoise,
    disturbance = null,
    seed = 20261008,
  } = o;
  const profile=normalizeSimProfile(o.simProfile??(legacyNoise===undefined?{}:{noise:legacyNoise}),dtMs);
  if(o.simProfile && legacyNoise!==undefined && legacyNoise!==profile.noise) throw Error('noise 与 simProfile.noise 冲突');
  const noise=profile.noise;

  for (const [name, value] of Object.entries({ target, durationMs, x0, dtMs, sampleMs, noise, seed })) {
    if (!Number.isFinite(value)) throw new Error(`sim ${name} 必须是有限数字`);
  }
  if (durationMs <= 0 || durationMs > 4000 || dtMs <= 0 || sampleMs <= 0 || noise < 0)
    throw new Error('sim 时长必须在 (0,4000]ms，采样周期为正，噪声非负');
  if (![durationMs,dtMs,sampleMs].every(Number.isInteger) || durationMs % dtMs || sampleMs % dtMs)
    throw new Error('sim 时长与遥测周期必须是整数控制周期的倍数');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new Error('seed 必须是 uint32');
  for (const [name, value] of Object.entries(gains)) {
    if (!Number.isFinite(value)) throw new Error(`sim 参数 ${name} 必须是有限数字`);
  }
  if (disturbance && (!Number.isFinite(disturbance.atMs) || !Number.isFinite(disturbance.impulseDegPerSec)))
    throw new Error('sim 扰动时间和幅度必须是有限数字');

  if (disturbance && (disturbance.atMs < 0 || disturbance.atMs >= durationMs || disturbance.atMs % dtMs))
    throw new Error('sim 扰动必须落在实验内部的控制时刻');

  const Kp = gains.AngleKp ?? 5;
  const Ki = gains.AngleKi ?? 0.1;
  const Kd = gains.AngleKd ?? 5;
  const offset = gains.Offset ?? 0;
  const errIntMax = 1000;

  const rnd = mulberry32(seed);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2; // 近似正态，落在 ±1

  let th = (x0 / DEG);   // 弧度
  let om = 0;            // 弧度/秒
  let errInt = 0;
  let prevThDeg = x0;

  const samples = [];
  const steps = Math.floor(durationMs / dtMs);
  const sampleEvery = Math.max(1, Math.round(sampleMs / dtMs));
  let termination = { reason: 'duration', atMs: durationMs };
  let u = 0;
  let appliedOutput=0;
  const angleHistory=[];
  const delaySteps=profile.measurementDelayMs/dtMs;
  const lagAlpha=profile.actuatorLagMs===0?1:1-Math.exp(-dtMs/profile.actuatorLagMs);
  const emit = ms => samples.push({ms, angle:Number((th*DEG).toFixed(3)),target,
    out:Number(u.toFixed(2)),spdL:Number((u*.6).toFixed(1)),spdR:Number((u*.6).toFixed(1)),errInt:Number(errInt.toFixed(2))});

  for (let i = 0; i <= steps; i++) {
    const ms = i * dtMs;
    if (Math.abs(th*DEG) > FALL_DEG) {
      termination={reason:'fall',atMs:ms,angleDeg:Number((th*DEG).toFixed(3))};
      emit(ms);break;
    }
    // 终点只报告已到达的状态，不额外执行积分/控制周期。out保留最后施加值。
    if(i===steps) {emit(ms);break;}
    if (disturbance && ms === disturbance.atMs) {
      om += (disturbance.impulseDegPerSec ?? 60) / DEG;   // 手推：直接给角速度一个冲量
    }

    const thDeg = th * DEG;
    angleHistory.push(thDeg);
    const delayed=angleHistory[Math.max(0,i-delaySteps)];
    const measured = delayed + noise * gauss(); // 延迟真实角度，再加入当前传感器噪声

    // ---- 与固件同构的 PID 计算（每 10ms 一次）----
    const e = target - measured;
    if (Ki !== 0) {
      errInt += e;
      errInt = clamp(errInt, -errIntMax, errIntMax);      // 积分限幅
    } else {
      errInt = 0;                                         // Ki=0 时积分清零（固件同款）
    }
    let uPid = Kp * e + Ki * errInt - Kd * (measured - prevThDeg); // 微分先行
    if (uPid > 0) uPid += offset;
    if (uPid < 0) uPid -= offset;
    uPid = clamp(uPid, -100, 100);                        // 输出限幅（固件在 PID_Update 内完成）
    prevThDeg = measured;

    //  关键符号约定：固件 main.c 里 AvePWM = -AnglePID.Out;
    //    PID 输出取反后才作用到电机。仿真必须复刻这一步，否则符号相反、立即摔倒。
    u = clamp(-uPid, -100, 100);
    const deadZoned=Math.sign(u)*Math.max(Math.abs(u)-profile.deadZoneOutput,0);
    appliedOutput=profile.actuatorLagMs===0?deadZoned:appliedOutput+lagAlpha*(deadZoned-appliedOutput);
    // t时刻真实状态与本周期输出；out对[t,t+dt)左端保持。
    if(i % sampleEvery === 0) emit(ms);

    // ---- 被控对象积分（半隐式欧拉）----
    // θ'' = A_FALL·sinθ − B_CTRL·u·cosθ − DAMP·θ'
    //  单位一致性：th/om 用弧度，而 B_CTRL 是按"度"标定的（deg/s² per PWM），
    //    因此控制项必须除以 DEG 换算回 rad/s²。这一步搞错会让控制权限放大 57.3 倍，
    //    表现为"车瞬间回正、完全看不到动态";是仿真最常见的隐蔽错误。
    const alpha = A_FALL * Math.sin(th) - (B_CTRL / DEG) * profile.controlScale * appliedOutput * Math.cos(th) - DAMP * profile.dampingScale * om;
    om += alpha * dtMs / 1000;
    th += om * dtMs / 1000;


  }

  Object.defineProperty(samples, 'termination', { value: termination, enumerable: false });
  Object.defineProperty(samples,'simConfig',{value:{modelVersion:hasSimPressure(profile)?SIM_PRESSURE_VERSION:SIM_MODEL_VERSION,
    controlDtMs:dtMs,sampleMs,simProfile:profile},enumerable:false});
  return samples;
}

/**
 * 预设工况：用于 selftest 的三类测试样例（正常 / 边界 / 失败）
 * 对应的期望判据写在 bridge/cli.js 的 selftest 里，两者必须同步修改。
 */
export const SIM_PRESETS = {
  'normal-tuned': { gains: { AngleKp: 4, AngleKi: 0, AngleKd: 8 }, label: '正常：整定后参数（网格最优附近）' },
  'normal-conservative': { gains: { AngleKp: 4, AngleKi: 0, AngleKd: 16 }, label: '正常：偏保守（Kd 较大）' },
  'boundary-high-kd': { gains: { AngleKp: 8, AngleKi: 0, AngleKd: 20 }, label: '边界：Kd 贴上限' },
  'boundary-zero-ki': { gains: { AngleKp: 6, AngleKi: 0, AngleKd: 6 }, label: '边界：Ki=0（无积分）' },
  'fail-no-control': { gains: { AngleKp: 0, AngleKi: 0, AngleKd: 0 }, label: '失败：无控制 → 摔倒' },
  'fail-between-samples': { gains: { AngleKp: 3, AngleKi: 0, AngleKd: 2 }, label: '失败：摔倒发生在两次遥测采样之间' },
  'fail-underdamped': { gains: { AngleKp: 12, AngleKi: 0, AngleKd: 0 }, label: '失败：欠阻尼 → 持续振荡' },
  'fail-windup': { gains: { AngleKp: 5, AngleKi: 0.1, AngleKd: 5 }, label: '失败：积分参与后未收敛（出厂默认值；非windup定论）' },
};
