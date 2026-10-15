/** Deterministic tool demonstration; NOT evidence of AI-selected candidates. */
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {paths} from '../bridge/lib/store.js';
const campaign='tool-demo-'+Date.now();
const plan=JSON.parse(readFileSync(new URL('../configs/simulation-plan.example.json',import.meta.url),'utf8'));
plan.campaign=campaign;plan.maxSearch=3;
const planFile=join(paths.runs,'plans',campaign+'.json');mkdirSync(join(paths.runs,'plans'),{recursive:true});writeFileSync(planFile,JSON.stringify(plan,null,2));
let parent;
const call=args=>{const r=spawnSync(process.execPath,[resolve('bridge/cli.js'),...args,'--json'],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||r.stdout);return JSON.parse(r.stdout);};
const attempt=(gains,purpose,c,reason)=>{
 const args=['trial','--backend','sim','--campaign',campaign,'--plan',planFile,'--purpose',purpose,'--reason',reason,'--gains',gains,'--dur',String(c.durationMs),'--target',String(c.target),'--x0',String(c.x0),'--seed',String(c.seed)];
 if(parent)args.push('--parent',parent);if(c.disturbance!==null)args.push('--disturb',String(c.disturbance));
 const r=call(args);parent=r.runId;return r;
};
const rows=[['Kp=5,Ki=0.1,Kd=5','固定演示基线'],['Kp=4,Ki=0,Kd=8','固定演示：历史已知可行先验'],['Kp=4.5,Ki=0,Kd=8','固定演示：邻域对照']].map(([g,reason])=>attempt(g,'search',plan.search,reason));
const feasible=rows.filter(r=>r.decisionEligible&&Number.isFinite(r.metrics.j));
if(feasible.length){const best=feasible.reduce((a,b)=>a.metrics.j<=b.metrics.j?a:b);const g=Object.entries(best.gains).map(([k,v])=>k+'='+v).join(',');for(const c of plan.validation)attempt(g,'robustness',c,'固定演示：冻结已测最优，运行预声明验证');}
const report=call(['report','--campaign',campaign]);
console.log(JSON.stringify({kind:'deterministic-tool-demo-not-AI',...report},null,2));
