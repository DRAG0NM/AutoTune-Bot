#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {loadCsv} from '../bridge/backends/replay.js';
import {diagnose} from '../bridge/lib/diagnostics.js';
import {readIndex,paths} from '../bridge/lib/store.js';

try {
  const args=process.argv.slice(2),flags={};
  for(let i=0;i<args.length;i+=2) {
    if(!['--csv','--run-id','--campaign','--at','--tol','--hold','--out'].includes(args[i]) ||
        !args[i+1] || args[i+1].startsWith('--') || flags[args[i]]!==undefined) throw Error('诊断选项未知、重复或缺值');
    flags[args[i]]=args[i+1];
  }
  const selectors=['--csv','--run-id','--campaign'].filter(k=>flags[k]);
  if(selectors.length!==1) throw Error('指定 --csv、--run-id 或 --campaign 其中一个');
  const numeric=k=>flags[k]===undefined?undefined:Number(flags[k]);
  let records;
  if(flags['--csv']) records=[{csvPath:resolve(flags['--csv'])}];
  else {
    records=readIndex().filter(r=>flags['--run-id']?r.runId===flags['--run-id']:r.campaign===flags['--campaign']);
    if(!records.length) throw Error('没有对应实验');
  }
  const results=records.map(r=>{
    if(!r.csvPath && (!r.csv || basename(r.csv)!==r.csv)) throw Error('实验CSV缺失或文件名非法');
    const file=r.csvPath??resolve(paths.runs,r.csv),bytes=readFileSync(file);
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(r.csvHash && r.csvHash!==hash) throw Error('CSV hash不符');
    const firstLine=bytes.toString('utf8').replace(/^\uFEFF/,'').split(/\r?\n/)
      .find(l=>l.trim()&&!l.trim().startsWith('#'));
    if(!firstLine) throw Error('CSV为空');
    const header=firstLine.split(',').map(x=>x.trim().toLowerCase());
    let at=numeric('--at'),atMsSource=at===undefined?null:'flag';
    if(at===undefined) {
      const d=r.meta?.sim?.disturbance;
      at=r.meta?.sim?.disturbanceEvent?.atMs??(d===null||d===undefined?null:typeof d==='object'?d.atMs:Math.floor(r.durationMs/2));
      atMsSource=at===null?null:r.meta?.sim?.disturbanceEvent?'recorded-event':typeof d==='object'?'recorded-object':'legacy-half-duration';
    }
    const result=diagnose(loadCsv(file),{disturbanceAtMs:at,tolerance:numeric('--tol')??r.metrics?.tol??0.1,
      holdMs:numeric('--hold')??r.evaluation?.metrics?.settleHoldMs??300,integralAvailable:header.includes('errint')});
    return {runId:r.runId??null,csv:basename(file),csvHash:hash,gains:r.gains??null,disturbanceAtMsSource:atMsSource,diagnostics:result};
  });
  const output={ok:true,campaign:flags['--campaign']??null,results};
  const text=JSON.stringify(output,null,2)+'\n';
  if(flags['--out']) {
    const out=resolve(flags['--out']);
    if(existsSync(out)||!out.toLowerCase().endsWith('.json')) throw Error('输出必须为尚不存在的.json文件');
    writeFileSync(out,text,{flag:'wx'});
  }
  console.log(text);
} catch(e) {console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
