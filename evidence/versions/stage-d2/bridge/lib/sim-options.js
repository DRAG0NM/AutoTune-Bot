// 仿真压力参数是实验假设，未经实车辨识；禁止用于 serial/replay。
export const SIM_PROFILE_DEFAULTS = Object.freeze({
  actuatorLagMs:0, deadZoneOutput:0, measurementDelayMs:0,
  noise:0.05, controlScale:1, dampingScale:1,
});
import {normalizeSimController} from './sim-controller.js';
const bounds={actuatorLagMs:[0,200],deadZoneOutput:[0,20],measurementDelayMs:[0,200],
  noise:[0,2],controlScale:[0.5,1.5],dampingScale:[0.5,1.5]};
export function normalizeSimProfile(input={},dtMs=10) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw Error('simProfile 必须是 JSON 对象');
  for(const key of Object.keys(input)) if(!Object.hasOwn(bounds,key)) throw Error(`未知 simProfile 选项: ${key}`);
  const result={...SIM_PROFILE_DEFAULTS,...input};
  for(const [key,[lo,hi]] of Object.entries(bounds))
    if(typeof result[key]!=='number' || !Number.isFinite(result[key]) || result[key]<lo || result[key]>hi)
      throw Error(`simProfile ${key} 必须在 [${lo},${hi}]`);
  if(!Number.isInteger(result.measurementDelayMs) || result.measurementDelayMs%dtMs)
    throw Error('measurementDelayMs 必须是整数控制周期的倍数');
  return result;
}
export const hasSimPressure=p=>Object.keys(SIM_PROFILE_DEFAULTS).some(k=>p[k]!==SIM_PROFILE_DEFAULTS[k]);
// 使用值及固定键序比较条件，而非文件名或输入 JSON 的键序。
export function simConditions(c) {
  return {durationMs:c.durationMs,target:c.target,x0:c.x0,seed:c.seed,disturbance:c.disturbance,
    simProfile:normalizeSimProfile(c.simProfile??{}),simController:normalizeSimController(c.simController??{})};
}
