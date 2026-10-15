// 仿真时序诊断；不改变历史评价J。
export const DIAGNOSTIC_VERSION = '1.0';

export function diagnose(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length < 2) throw new Error('诊断至少需要2个样本');
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s || ['ms','angle','target','out'].some(k => !Number.isFinite(s[k])) || s.ms < 0 ||
        (i && s.ms <= samples[i-1].ms) || s.target !== samples[0].target)
      throw new Error('诊断要求有限数据、固定目标及严格递增时间');
  }
  const { tolerance = 0.1, holdMs = 300, tailFraction = 0.3, outputLimit = 100,
    integralLimit = 1000, disturbanceAtMs = null, integralAvailable = true, maxGapMs = 100 } = options;
  if (![tolerance,holdMs,tailFraction,outputLimit,integralLimit,maxGapMs].every(Number.isFinite) ||
      tolerance < 0 || holdMs <= 0 || tailFraction <= 0 || tailFraction > 1 ||
      outputLimit <= 0 || integralLimit <= 0 || maxGapMs <= 0 ||
      (disturbanceAtMs !== null && (!Number.isFinite(disturbanceAtMs) || disturbanceAtMs < 0)))
    throw new Error('诊断配置非法');
  const first = samples[0].ms, last = samples.at(-1).ms, span = last-first;
  const errors = samples.map(s=>s.angle-s.target);
  let iae=0, ise=0, outputEnergy=0, variation=0, saturatedMs=0;
  const gaps=[];
  for (let i=0;i<samples.length-1;i++) {
    const dt=samples[i+1].ms-samples[i].ms;
    gaps.push(dt); iae+=Math.abs(errors[i])*dt/1000; ise+=errors[i]**2*dt/1000;
    outputEnergy+=samples[i].out**2*dt/1000;
    variation+=Math.abs(samples[i+1].out-samples[i].out);
    if (Math.abs(samples[i].out)>=outputLimit) saturatedMs+=dt;
  }
  const tailStartMs=last-span*tailFraction;
  // 尾窗按时间截取，左端保持可完整涵盖非均匀采样与切窗边界。
  let tailMs=0, sum=0, abs=0, squares=0, outSquares=0;
  for(let i=0;i<samples.length-1;i++) {
    const ms=Math.max(0,samples[i+1].ms-Math.max(samples[i].ms,tailStartMs));
    tailMs+=ms;sum+=errors[i]*ms;abs+=Math.abs(errors[i])*ms;squares+=errors[i]**2*ms;
    outSquares+=samples[i].out**2*ms;
  }
  const integralOk=integralAvailable && samples.every(s=>Number.isFinite(s.errInt));
  const integral=integralOk ? {available:true,maxAbs:Math.max(...samples.map(s=>Math.abs(s.errInt))),
    first:samples[0].errInt,last:samples.at(-1).errInt,
    observedLimitSamples:samples.filter(s=>Math.abs(s.errInt)>=integralLimit).length,
    unit:'degree per control-step sum',limit:integralLimit} : {available:false};
  let disturbance=null;
  if(disturbanceAtMs!==null) {
    const after=samples.filter(s=>s.ms>=disturbanceAtMs);
    let recoveryAt=null;
    // 最后一次越界之后的全部观测须留在容差内，并持续 holdMs。
    for(let i=0;i<after.length;i++) {
      if(after.at(-1).ms-after[i].ms>=holdMs && after.slice(i).every((s,j,a)=>
          Math.abs(s.angle-s.target)<=tolerance && (!j||s.ms-a[j-1].ms<=maxGapMs))) {
        recoveryAt=after[i].ms;break;
      }
    }
    disturbance={atMs:disturbanceAtMs,observed:after.length>0,firstObservedMs:after[0]?.ms??null,
      observedPeakErrorDeg:after.length?Math.max(...after.map(s=>Math.abs(s.angle-s.target))):null,
      recovered:recoveryAt!==null,recoveryMs:recoveryAt===null?null:recoveryAt-disturbanceAtMs,
      observedAfterMs:Math.max(0,last-Math.max(first,disturbanceAtMs)),holdMs,toleranceDeg:tolerance,maxGapMs,
      observedMaxGapMs:after.length>1?Math.max(...after.slice(1).map((s,i)=>s.ms-after[i].ms)):null,
      recoveryWindowMaxGapMs:recoveryAt===null?null:Math.max(...after.filter(s=>s.ms>=recoveryAt).slice(1)
        .map((s,i,a)=>s.ms-(i?a[i-1].ms:recoveryAt))),
      sparseObserved:after.some((s,i)=>i&&s.ms-after[i-1].ms>maxGapMs)};
  }
  return {version:DIAGNOSTIC_VERSION,method:'left-end zero-order hold',
    quality:{samples:samples.length,startMs:first,endMs:last,spanMs:span,
      minGapMs:Math.min(...gaps),maxGapMs:Math.max(...gaps),meanGapMs:span/gaps.length},
    error:{iaeDegSec:iae,iseDeg2Sec:ise},
    tail:{startMs:tailStartMs,endMs:last,meanErrorDeg:sum/tailMs,meanAbsErrorDeg:abs/tailMs,
      rmsErrorDeg:Math.sqrt(squares/tailMs),rmsOutput:Math.sqrt(outSquares/tailMs)},
    output:{limit:outputLimit,observedPeakAbs:Math.max(...samples.map(s=>Math.abs(s.out))),
      observedSaturatedSamples:samples.filter(s=>Math.abs(s.out)>=outputLimit).length,
      observedSaturatedFraction:saturatedMs/span,energyOutputSquaredSec:outputEnergy,totalVariation:variation},
    integral,disturbance,
    limitations:['稀疏遥测不能排除采样之间的饱和或高频抖动','积分限幅状态不能单独证明或排除windup',
      '恢复仅描述有限观测窗口，不代表永久稳定','整轮J与反向过冲不等于施扰后的偏差峰值',
      '输出能量代理不等于电功率，派生轮速不等于真实运动']};
}
