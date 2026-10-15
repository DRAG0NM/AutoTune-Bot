/** Simulation datasets, append-only run index and generated artifacts. */
import{readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync}from'node:fs';import{resolve,dirname}from'node:path';import{fileURLToPath}from'node:url';import{randomUUID}from'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const paths={root,runs:process.env.AUTOTUNE_RUNS_DIR?resolve(process.env.AUTOTUNE_RUNS_DIR):resolve(root,'runs')};
export function writeRunCsv(tag,samples){
 if(tag&&!/^[a-zA-Z0-9_-]{1,80}$/.test(tag))throw Error('非法tag');mkdirSync(paths.runs,{recursive:true});
 const name='run_'+new Date().toISOString().replace(/[:.]/g,'-')+'_'+randomUUID().slice(0,8)+(tag?'_'+tag:'')+'.csv';
 const columns=['ms','angle','target','angularVelocity','out','appliedOut','errInt'];
 const body=samples.map(s=>columns.map(k=>Number.isFinite(s[k])?s[k]:'').join(',')).join('\n');
 writeFileSync(resolve(paths.runs,name),columns.join(',')+'\n'+body+'\n');return name;
}
export function appendIndex(record){mkdirSync(paths.runs,{recursive:true});appendFileSync(resolve(paths.runs,'index.jsonl'),JSON.stringify(record)+'\n');}
export function readIndex(){const p=resolve(paths.runs,'index.jsonl');return existsSync(p)?readFileSync(p,'utf8').split('\n').filter(Boolean).map((line,i)=>{try{return JSON.parse(line);}catch{throw Error('索引损坏行'+(i+1));}}):[];}
