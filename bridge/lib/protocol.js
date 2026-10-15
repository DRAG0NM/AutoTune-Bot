/** Simulation parameter contract. No device transport or command encoding. */
export const PARAM_LIMITS={AngleKp:[0,20],AngleKi:[0,5],AngleKd:[0,20]};
export const TUNABLE=Object.freeze(Object.keys(PARAM_LIMITS));
export const SIM_DEFAULTS=Object.freeze({AngleKp:5,AngleKi:.1,AngleKd:5});
export function clampParam(name,value){
 if(!Object.hasOwn(PARAM_LIMITS,name))throw Error('未知参数: '+name);
 const n=Number(value);if(!Number.isFinite(n))throw Error('参数必须为有限数字: '+name);
 const [lo,hi]=PARAM_LIMITS[name],v=Math.min(hi,Math.max(lo,n));return {value:v,clamped:v!==n};
}
export function parseGainList(text,base=SIM_DEFAULTS,allowed=TUNABLE){
 const gains={};for(const k of allowed)if(base[k]!==undefined)gains[k]=clampParam(k,base[k]).value;
 if(!text)return gains;const seen=new Set();
 for(const pair of String(text).split(',')){
  const parts=pair.split('=');if(parts.length!==2||!parts[0].trim()||!parts[1].trim())throw Error('非法参数组: '+pair);
  const key=({Kp:'AngleKp',Ki:'AngleKi',Kd:'AngleKd'})[parts[0].trim()]??parts[0].trim();
  if(!allowed.includes(key))throw Error('不允许参数: '+key+'；只支持Kp/Ki/Kd');
  if(seen.has(key))throw Error('重复参数: '+key);seen.add(key);
  const p=clampParam(key,parts[1]);if(p.clamped)throw Error('参数超出范围: '+key);gains[key]=p.value;
 }return gains;
}
