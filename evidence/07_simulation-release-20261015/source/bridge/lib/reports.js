/** Portable SVG/HTML reports, produced from the recorded simulation datasets. */
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {paths,readIndex} from './store.js';
import {loadCsv} from '../backends/replay.js';
import {computeMetrics} from './metrics.js';
import {simConditions} from './sim-options.js';
import {diagnose} from './diagnostics.js';
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=x=>typeof x==='number'&&Number.isFinite(x)?Number(x.toFixed(6)):x??'—';
const colors=['#2563eb','#0f9d83','#dc6537'];
const style=`body{font:16px system-ui,sans-serif;background:#f1f5f9;color:#152238;margin:0}main{max-width:1120px;margin:auto;padding:32px}h1{font-size:30px}small,p{line-height:1.6}section,article{background:white;border:1px solid #dce4ee;border-radius:12px;padding:20px;margin:18px 0}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e5eaf0}svg{max-width:100%;height:auto}a{color:#1d4ed8}code{overflow-wrap:anywhere}.badge{color:#0b7865;font-weight:600}`;
function chart(title,series,{xLabel='Time / s',yLabel='Angle / deg'}={}){
 const points=series.flatMap(s=>s.points.filter(p=>p.every(Number.isFinite)));
 const width=1000,height=360,L=84,R=28,T=70,B=60;
 let minX=points.length?Math.min(...points.map(p=>p[0])):0,maxX=points.length?Math.max(...points.map(p=>p[0])):1;
 let minY=points.length?Math.min(0,...points.map(p=>p[1])):0,maxY=points.length?Math.max(0,...points.map(p=>p[1])):1;
 if(maxX===minX)maxX=minX+1;if(maxY===minY)maxY=minY+1;
 const pad=(maxY-minY)*.08;minY-=pad;maxY+=pad;
 const X=x=>L+(x-minX)/(maxX-minX)*(width-L-R),Y=y=>height-B-(y-minY)/(maxY-minY)*(height-T-B);
 const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${esc(title)}</title><rect width="100%" height="100%" fill="white"/><g font-family="Arial,Microsoft YaHei,sans-serif" fill="#26354a"><text x="${L}" y="27" font-size="20" font-weight="bold">${esc(title)}</text>`];
 for(let i=0;i<=5;i++){
  const x=minX+(maxX-minX)*i/5,y=minY+(maxY-minY)*i/5;
  parts.push(`<path d="M${X(x)} ${T}V${height-B} M${L} ${Y(y)}H${width-R}" stroke="#e3e9f1" fill="none"/><text x="${X(x)}" y="${height-B+23}" text-anchor="middle" font-size="12">${fmt(x)}</text><text x="${L-10}" y="${Y(y)+4}" text-anchor="end" font-size="12">${fmt(y)}</text>`);
 }
 for(const [i,s]of series.entries()){
  const data=s.points.filter(p=>p.every(Number.isFinite)),color=s.color??colors[i%colors.length];
  const coordinates=data.map(p=>`${X(p[0]).toFixed(2)},${Y(p[1]).toFixed(2)}`).join(' ');
  parts.push(`<polyline points="${coordinates}" stroke="${color}" stroke-width="2" fill="none"/>`);
  if(data.length<=30)for(const p of data)parts.push(`<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="${color}"/>`);
  parts.push(`<text x="${L+i*250}" y="50" fill="${color}" font-size="13">${esc(s.name)}</text>`);
 }
 parts.push(`<text x="${width/2}" y="${height-10}" text-anchor="middle" font-size="13">${esc(xLabel)}</text><text transform="translate(18,${height/2}) rotate(-90)" text-anchor="middle" font-size="13">${esc(yLabel)}</text></g></svg>`);
 return parts.join('\n');
}
const html=(title,body)=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${style}</style><main><div class="badge">PID AI · Simulation</div><h1>${esc(title)}</h1>${body}</main></html>`;
function metricsTable(record){
 const m=record.metrics;
 return `<table><tr><th>参数</th><th>J</th><th>收敛</th><th>超调比</th><th>调节时间 / ms</th><th>稳态误差 / deg</th><th>控制能量代理</th></tr><tr><td>${esc(JSON.stringify(record.gains))}</td><td>${esc(m.j)}</td><td>${m.converged?'是':'否'}</td><td>${esc(m.overshoot)}</td><td>${esc(m.settlingMs)}</td><td>${esc(m.ssErr)}</td><td>${esc(m.energy)}</td></tr></table>`;
}
export function writeTrialArtifacts(record,samples){
 const dir=join(paths.runs,'artifacts',record.runId);mkdirSync(dir,{recursive:true});
 const prefix='artifacts/'+record.runId+'/';
 const refs={response:prefix+'response.svg',control:prefix+'control.svg',phase:prefix+'phase.svg',report:prefix+'report.html',record:prefix+'record.json'};
 const response=chart('角度响应与目标',[{name:'angle',points:samples.map(s=>[s.ms/1000,s.angle])},{name:'target',points:samples.map(s=>[s.ms/1000,s.target])}]);
 const control=chart('控制指令与有效输入',[{name:'command',points:samples.map(s=>[s.ms/1000,s.out])},{name:'applied',points:samples.map(s=>[s.ms/1000,s.appliedOut])}],{yLabel:'Normalized control / [-100,100]'});
 const phase=chart('倒立摆相轨迹',[{name:'angular state',points:samples.map(s=>[s.angle,s.angularVelocity])}],{xLabel:'Angle / deg',yLabel:'Angular velocity / deg/s'});
 for(const [name,value]of [['response.svg',response],['control.svg',control],['phase.svg',phase]])writeFileSync(join(dir,name),value);
 const info=`<p>纯数值仿真；模型、离散控制器、工况和源码身份见记录JSON。图表来自本轮CSV对应样本；能量为控制输入平方积分代理。回放缺失的角速度/有效输入留空，不推造。</p><section>${metricsTable(record)}<p>结果：${esc(record.metrics.reason??(record.metrics.fail?'失败':record.metrics.converged?'收敛':'未收敛'))}；模拟时长 ${record.durationMs}ms。</p><code>runId: ${esc(record.runId)}</code><p><a href="../../${encodeURIComponent(record.csv)}">原始CSV</a> · <a href="record.json">记录JSON</a></p></section><article>${response}</article><article>${control}</article><article>${phase}</article>`;
 writeFileSync(join(dir,'report.html'),html('二阶倒立摆 PID 仿真报告',info));
 writeFileSync(join(dir,'record.json'),JSON.stringify({...record,artifacts:refs},null,2));
 return refs;
}
const csvCell=v=>{const s=String(v??'');return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
export function writeCampaignReport({campaign,outDir}={}){
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(campaign??''))throw Error('report需要合法campaign');
 const records=readIndex().filter(r=>r.campaign===campaign);if(!records.length)throw Error('campaign没有记录');
 if(new Set(records.map(r=>r.sourceHash)).size!==1)throw Error('同一报告不能混用源码版本');
 const condition=r=>simConditions({durationMs:r.durationMs,target:r.target,x0:r.meta.sim.x0,seed:r.meta.sim.seed,disturbance:r.meta.sim.disturbance,simProfile:r.meta.sim.simProfile,simController:r.meta.sim.controller});
 const plan=records[0].experimentPlan??null,ids=new Set();let previous=null;
 for(const r of records){
  if(r.backend!=='sim'||ids.has(r.runId)||(r.decision?.parent??null)!==(previous?.runId??null))throw Error('记录类型、runId或parent链非法');
  ids.add(r.runId);previous=r;
  if(!['search','robustness'].includes(r.decision.purpose))throw Error('试验用途非法');
  if(JSON.stringify(r.experimentPlan??null)!==JSON.stringify(plan))throw Error('冻结plan不一致');
  if(!r.csv||basename(r.csv)!==r.csv)throw Error('CSV路径非法');
  const data=readFileSync(join(paths.runs,r.csv));if(createHash('sha256').update(data).digest('hex')!==r.csvHash)throw Error('CSV hash 不符：'+r.runId);
  const samples=loadCsv(join(paths.runs,r.csv));
  const actual=computeMetrics(samples,{...r.evaluation.metrics,weights:r.evaluation.weights,termination:r.meta.sim?.termination});
  for(const k of ['fail','converged','n','j','overshoot','settlingMs','ssErr','energy']){
   const norm=v=>Number.isNaN(v)?null:typeof v==='number'&&!Number.isFinite(v)?String(v):v;
   if(norm(actual[k])!==r.metrics[k])throw Error('指标复算不一致：'+r.runId+'/'+k);
  }
  const diagnostics=diagnose(samples,{tolerance:actual.tol??r.evaluation.metrics.tolFloor,holdMs:r.evaluation.metrics.settleHoldMs,disturbanceAtMs:r.meta.sim.disturbanceEvent?.atMs??null});
  if(JSON.stringify(diagnostics)!==JSON.stringify(r.diagnostics))throw Error('诊断复算不一致：'+r.runId);
  const eligible=actual.ok&&actual.converged&&(plan?.objective!=='impulse-recovery'||diagnostics.disturbance?.recovered===true);
  if(r.decisionEligible!==eligible)throw Error('候选资格不一致：'+r.runId);
 }
 const searches=records.filter(r=>r.decision.purpose==='search');
 if(new Set(searches.map(r=>JSON.stringify({condition:condition(r),evaluation:r.evaluation}))).size>1)throw Error('搜索工况或评价不一致');
 const validation=records.filter(r=>r.decision.purpose==='robustness');
 let validationStarted=false;for(const r of records){if(r.decision.purpose==='robustness')validationStarted=true;else if(validationStarted)throw Error('验证后不能回到搜索');}
 if(plan){
  if(searches.length>plan.maxSearch||validation.length>plan.validation.length)throw Error('计划预算超限');
  if(searches.some(r=>JSON.stringify(condition(r))!==JSON.stringify(simConditions(plan.search)))||validation.some((r,i)=>JSON.stringify(condition(r))!==JSON.stringify(simConditions(plan.validation[i]))))throw Error('记录不符合冻结工况');
 }
 const gainKey=r=>['AngleKp','AngleKi','AngleKd'].map(k=>r.gains[k]).join(',');
 if(new Set(validation.map(gainKey)).size>1)throw Error('验证候选没有冻结');
 const feasible=searches.filter(r=>r.decisionEligible===true&&Number.isFinite(r.metrics.j));
 const best=feasible.length?feasible.reduce((a,b)=>a.metrics.j<=b.metrics.j?a:b):null;
 if(validation.length&&(!best||validation.some(r=>gainKey(r)!==gainKey(best))))throw Error('验证参数不是已测可行最优');
 const dir=outDir?resolve(outDir):join(paths.runs,'reports',campaign);mkdirSync(dir,{recursive:true});
 const files={metricsCsv:join(dir,'metrics.csv'),historySvg:join(dir,'objective-history.svg'),gainsSvg:join(dir,'pid-history.svg'),html:join(dir,'report.html'),json:join(dir,'summary.json')};
 const header=['round','runId','purpose','Kp','Ki','Kd','fail','converged','J','overshoot','settlingMs','ssErr','energy','IAE_deg_s','ISE_deg2_s','tailRMS_deg','csv'];
 const body=records.map((r,i)=>[i+1,r.runId,r.decision.purpose,r.gains?.AngleKp,r.gains?.AngleKi,r.gains?.AngleKd,r.metrics.fail,r.metrics.converged,r.metrics.j,r.metrics.overshoot,r.metrics.settlingMs,r.metrics.ssErr,r.metrics.energy,r.diagnostics?.error?.iaeDegSec,r.diagnostics?.error?.iseDeg2Sec,r.diagnostics?.tail?.rmsErrorDeg,r.csv].map(csvCell).join(',')).join('\n');
 writeFileSync(files.metricsCsv,header.join(',')+'\n'+body+'\n');
 const history=chart('逐轮目标值（全部结果保留在CSV）',[{name:'search J (finite)',points:records.map((r,i)=>[i+1,r.decision.purpose==='search'&&Number.isFinite(r.metrics.j)?r.metrics.j:null])}],{xLabel:'Trial / round',yLabel:'Objective J (lower is better)'});
 const gains=chart('PID 参数变化',['AngleKp','AngleKi','AngleKd'].map(name=>({name,points:records.map((r,i)=>[i+1,r.gains?.[name]])})),{xLabel:'Trial / round',yLabel:'Discrete PID gain'});
 writeFileSync(files.historySvg,history);writeFileSync(files.gainsSvg,gains);
 const summary={schema:'pendulum-campaign-report/1',campaign,total:records.length,failed:records.filter(r=>r.metrics.fail).length,converged:records.filter(r=>r.metrics.converged&&!r.metrics.fail).length,best:best?{runId:best.runId,gains:best.gains,metrics:best.metrics}:null,sourceHash:records[0].sourceHash,files,modelEvidence:'记录证明工具执行；AI自主决策还需真实AGNES会话',scope:'已测同工况search候选的最优，非全局最优；验证轮不参与冠军排序'};
 Object.assign(summary,{searchCount:searches.length,distinctSearchPoints:new Set(searches.map(gainKey)).size,parameterChangeExecuted:new Set(searches.map(gainKey)).size>1,validationCount:validation.length,validationPlanned:plan?.validation.length??null,planComplete:plan?validation.length===plan.validation.length:null,validationPassed:validation.length?validation.every(r=>!r.metrics.fail&&r.metrics.converged&&(!r.meta.sim.disturbanceEvent||r.diagnostics?.disturbance?.recovered===true)):null});
 writeFileSync(files.json,JSON.stringify(summary,null,2));
 const rows=records.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.decision.purpose)}</td><td>${esc(JSON.stringify(r.gains))}</td><td>${r.metrics.fail?'失败':r.metrics.converged?'收敛':'未收敛'}</td><td>${esc(r.metrics.j)}</td><td>${esc(r.runId)}</td></tr>`).join('');
 const bestResponse=best?chart('已测可行最优的角度响应',[{name:'angle',points:loadCsv(join(paths.runs,best.csv)).map(s=>[s.ms/1000,s.angle])},{name:'target',points:loadCsv(join(paths.runs,best.csv)).map(s=>[s.ms/1000,s.target])}]):'';
 writeFileSync(files.html,html('PID 自主调参 · '+campaign,`<section><p>共 ${summary.total} 轮，失败 ${summary.failed}，收敛 ${summary.converged}。${best?'本次已测可行search最优：'+esc(JSON.stringify(best.gains))+'，J='+esc(best.metrics.j):'未找到可行最优参数'}</p><p>${esc(summary.scope)}。验证工况与搜索分开解释；失败或Infinity仍保留。</p><p><a href="metrics.csv">指标CSV</a> · <a href="summary.json">汇总JSON</a></p></section><article>${history}</article><article>${gains}</article>${bestResponse?'<article>'+bestResponse+'</article>':''}<section><table><tr><th>轮次</th><th>用途</th><th>PID</th><th>结果</th><th>J</th><th>runId</th></tr>${rows}</table></section><p>${esc(summary.modelEvidence)}</p>`));
 // Include validation status prominently, including incomplete or failed checks.
 const page=readFileSync(files.html,'utf8');writeFileSync(files.html,page.replace('<section>',`<section><p>实际不同搜索参数组：${summary.distinctSearchPoints}；已执行改参：${summary.parameterChangeExecuted?'是':'否'}；验证 ${summary.validationCount}/${summary.validationPlanned??'未声明'}；计划完成：${summary.planComplete===null?'未声明':summary.planComplete?'是':'否'}；验证通过：${summary.validationPassed===null?'未执行':summary.validationPassed?'是':'否'}。</p></section><section>`));
 return summary;
}
