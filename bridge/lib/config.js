import{readFileSync,existsSync}from'node:fs';import{resolve}from'node:path';import{paths}from'./store.js';
export const DEFAULT_CONFIG={trial:{durationMs:3000},metrics:{settleBand:.02,tolFloor:.1,ssWindow:.3,headWindow:.05,fallLimitDeg:50,minSamples:20,settleHoldMs:300},cost:{wOvershoot:.4,wSettling:.3,wSsErr:.2,wEnergy:.1},agents:{maxRounds:25,stopAfterNoImprovement:3,repeatPerParamSet:2}};
const merge=(base,patch,location='config')=>{
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error(location+'必须是配置对象');
 const result={...base};
 for(const [key,value] of Object.entries(patch)){
  if(key.startsWith('_'))continue;
  if(!Object.hasOwn(base,key))throw Error('未知仿真配置: '+location+'.'+key);
  if(typeof base[key]==='object')result[key]=merge(base[key],value,location+'.'+key);
  else {
   if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error(location+'.'+key+'必须是非负有限数');
   result[key]=value;
  }
 }
 return result;
};
let cached;
export function loadConfig(){
 if(cached)return cached;let config=structuredClone(DEFAULT_CONFIG);const used=[];
 for(const name of ['bridge.example.json','bridge.local.json']){const path=resolve(paths.root,'configs',name);if(existsSync(path)){const patch=JSON.parse(readFileSync(path,'utf8'));if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('配置必须是对象');config=merge(config,patch);used.push(name);}}
 for(const section of Object.values(config))for(const v of Object.values(section))if(!Number.isFinite(v)||v<0)throw Error('仿真配置必须是非负有限数');
 if(!Number.isInteger(config.trial.durationMs)||config.trial.durationMs<1000||config.trial.durationMs>60000||config.trial.durationMs%10)throw Error('durationMs必须为1000..60000ms及10ms整数倍');
 if(config.metrics.fallLimitDeg<=0||config.metrics.fallLimitDeg>50||!Number.isInteger(config.metrics.minSamples)||config.metrics.minSamples<2||config.metrics.ssWindow<=0||config.metrics.ssWindow>1||config.metrics.headWindow<=0||config.metrics.headWindow>1)throw Error('指标配置无效');
 if(Object.values(config.agents).some(v=>!Number.isInteger(v)||v<1)||Object.values(config.cost).reduce((a,b)=>a+b,0)<=0)throw Error('预算或权重无效');
 return cached={config,source:used.join(' + ')||'built-in'};
}
export const costWeights=(cfg=loadConfig().config)=>({overshoot:cfg.cost.wOvershoot,settling:cfg.cost.wSettling,ssErr:cfg.cost.wSsErr,energy:cfg.cost.wEnergy});
