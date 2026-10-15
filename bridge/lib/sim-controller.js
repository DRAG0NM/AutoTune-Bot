// Discrete PID variants; historical 10ms sum/difference convention retained.
export const SIM_CONTROLLER_VERSION = 'sim-controller-1';
export const SIM_CONTROLLER_DEFAULT = 'baseline';
export const SIM_CONTROLLER_NAMES = Object.freeze(['baseline', 'conditional-integral', 'derivative-filter']);

export function normalizeSimController(value = {}) {
  if (value === undefined || value === null) return { name: SIM_CONTROLLER_DEFAULT, derivativeFilterMs: null };
  if (typeof value === 'string') value = { name: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('simController 必须是 JSON 对象');
  const name = value.name ?? SIM_CONTROLLER_DEFAULT;
  if (!SIM_CONTROLLER_NAMES.includes(name)) throw new Error(`未知 simController: ${name}`);
  const derivativeFilterMs = value.derivativeFilterMs ?? (name === 'derivative-filter' ? 20 : null);
  if (name === 'derivative-filter' && derivativeFilterMs !== 20) throw new Error('derivative-filter 仅支持 20ms');
  if (name !== 'derivative-filter' && derivativeFilterMs !== null) throw new Error('非 derivative-filter 不允许 derivativeFilterMs');
  return { name, derivativeFilterMs };
}

export function createSimController(input = {}, { dtMs = 10 } = {}) {
  const config = normalizeSimController(input);
  const state = { errInt: 0, derivative: 0 };
  const stats = { controlSteps: 0, saturatedSteps: 0, integralSuppressedSteps: 0, maxAbsIntegral: 0 };
  const alpha = config.name === 'derivative-filter' ? dtMs / (config.derivativeFilterMs + dtMs) : 1;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const step = ({ gains, error, measured, previousMeasured, offset = 0, errIntMax = 1000 }) => {
    const Kp = gains.AngleKp ?? 5;
    const Ki = gains.AngleKi ?? 0.1;
    const Kd = gains.AngleKd ?? 5;
    let suppressed = false;
    if (Ki !== 0) {
      const candidate = clamp(state.errInt + error, -errIntMax, errIntMax);
      if (config.name === 'conditional-integral') {
        const withoutIntegral = Kp * error - Kd * (measured - previousMeasured);
        const candidateOutput = withoutIntegral + Ki * candidate;
        const drivesHigh = candidateOutput > 100 && error > 0;
        const drivesLow = candidateOutput < -100 && error < 0;
        if (drivesHigh || drivesLow) { suppressed = true; }
        else state.errInt = candidate;
      } else state.errInt = candidate;
    } else state.errInt = 0;
    const rawDerivative = measured - previousMeasured;
    const derivative = config.name === 'derivative-filter'
      ? (state.derivative += alpha * (rawDerivative - state.derivative))
      : rawDerivative;
    let uPid = Kp * error + Ki * state.errInt - Kd * derivative;
    if (uPid > 0) uPid += offset;
    if (uPid < 0) uPid -= offset;
    const saturated = uPid > 100 || uPid < -100;
    uPid = clamp(uPid, -100, 100);
    stats.controlSteps++;
    if (saturated) stats.saturatedSteps++;
    if (suppressed) stats.integralSuppressedSteps++;
    stats.maxAbsIntegral = Math.max(stats.maxAbsIntegral, Math.abs(state.errInt));
    return { uPid, errInt: state.errInt, suppressed };
  };
  return { config, state, stats, step,
    finish() { return { ...stats,
      saturatedFraction: stats.controlSteps ? stats.saturatedSteps / stats.controlSteps : 0,
      integralSuppressedFraction: stats.controlSteps ? stats.integralSuppressedSteps / stats.controlSteps : 0,
    }; }
  };
}
