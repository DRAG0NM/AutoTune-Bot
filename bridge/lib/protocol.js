/**
 * Encode the STM32 slider, command and heartbeat frames; parse telemetry.
 * See firmware/PATCHES.md for the required device-side implementation.
 */

/** 参数硬限幅：与固件侧的 PCLAMP 保持一致，防止智能体下发危险值 */
export const PARAM_LIMITS = {
  AngleKp: [0, 20],
  AngleKi: [0, 5],
  AngleKd: [0, 20],
  SpeedKp: [0, 20],
  SpeedKi: [0, 5],
  SpeedKd: [0, 20],
  TurnKp: [0, 20],
  TurnKi: [0, 10],
  TurnKd: [0, 20],
  Offset: [0, 30],
};

/** 课程出厂默认值（Kp/Ki/Kd），来自 09 版 main.c ; 作为对照基线 B0 */
export const FIRMWARE_DEFAULTS = {
  AngleKp: 5,
  AngleKi: 0.1,
  AngleKd: 5,
  SpeedKp: 2,
  SpeedKi: 0.05,
  SpeedKd: 0,
  TurnKp: 4,
  TurnKi: 3,
  TurnKd: 0,
  Offset: 0,
};

/* Only the three angle-loop gains are writable through this bridge. */
export const TUNABLE = ['AngleKp', 'AngleKi', 'AngleKd'];

export function clampParam(name, value) {
  const lim = PARAM_LIMITS[name];
  if (!lim) throw new Error(`未知参数: ${name}`);
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`参数 ${name} 非法: ${value}`);
  const [lo, hi] = lim;
  const c = Math.min(hi, Math.max(lo, v));
  return { value: c, clamped: c !== v };
}

export function encodeSlider(name, value) {
  const { value: v, clamped } = clampParam(name, value);
  return { frame: `[slider,${name},${v}]`, clamped, value: v };
}

/* Host command allowlist; each command is also exercised by selftest. */
export const ALLOWED_CMDS = ['Stop', 'Start', 'Zero'];

export function encodeCmd(cmd) {
  if (!ALLOWED_CMDS.includes(cmd)) {
    throw new Error(`未知命令: ${cmd}（已支持：${ALLOWED_CMDS.join(' / ')}）`);
  }
  return `[cmd,${cmd},1]`;
}

export function encodeHeartbeat(ms = Date.now()) {
  return `[hb,${ms}]`;
}

/** 遥测行：T,ms,angle,target,out,spdL,spdR,errInt  → 失败返回 null（不抛异常，容忍串口噪声） */
export function parseTelemetry(line) {
  const s = String(line).trim();
  if (!s.startsWith('T,')) return null;
  const p = s.split(',');
  if (p.length !== 8 || p.slice(1).some(v => v.trim() === '')) return null;
  const nums = p.slice(1, 8).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [ms, angle, target, out, spdL, spdR, errInt] = nums;
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xFFFFFFFF) return null;
  return { ms, angle, target, out, spdL, spdR, errInt };
}

/**
 * 解析命令行里的 k=v 参数组，例如 "AngleKp=6,AngleKd=5.5"
 *
 *  v2 修正：不再合并全部固件默认值。
 *   v1 的做法是 `{...FIRMWARE_DEFAULTS, ...base}`，结果每次 trial 都会把
 *   Speed/Turn/Offset 等 10 个参数一起下发给车;既覆盖了车上原有的其它环参数，
 *   又白白花掉 1.2 秒（10 帧 × 120ms）的采集窗口。
 *   v2 只允许下发 `allowed` 白名单内的参数（默认只有角度环三个）。
 *
 * @param {string} text      "AngleKp=4,AngleKd=8"
 * @param {object} base      last-known-good（只取其白名单内的字段）
 * @param {string[]} allowed 允许下发的参数名
 */
export function parseGainList(text, base = {}, allowed = TUNABLE) {
  const gains = {};
  for (const k of allowed) {
    if (base[k] !== undefined) gains[k] = clampParam(k, base[k]).value;
  }
  if (!text) return gains;
  const seen = new Set();
  for (const pair of String(text).split(',')) {
    const parts = pair.split('=');
    const [k, v] = parts;
    if (parts.length !== 2 || !k?.trim() || !v?.trim()) throw new Error(`非法参数组: ${pair}`);
    const key = k.trim();
    if (!allowed.includes(key)) {
      throw new Error(
        `不允许通过 trial 下发参数「${key}」：只允许 ${allowed.join(' / ')}。\n` +
        `  如需调其它环，请显式扩展 protocol.js 里的 TUNABLE 白名单——` +
        `不要让它静默地连带写出车上的其它参数。`
      );
    }
    if (seen.has(key)) throw new Error(`重复参数: ${key}`);
    seen.add(key);
    const parsed = clampParam(key, Number(v));
    if (parsed.clamped) throw new Error(`参数 ${key} 超出范围，拒绝静默限幅`);
    gains[key] = parsed.value;
  }
  return gains;
}
