import test from 'node:test';
import assert from 'node:assert/strict';
import {runSim} from '../bridge/backends/sim.js';
import {computeMetrics} from '../bridge/lib/metrics.js';
test('objective exposes weighted contributions so raw energy cannot be mistaken for dominant cost',()=>{
 const samples=runSim({gains:{AngleKp:4,AngleKi:0,AngleKd:8}}),m=computeMetrics(samples);
 assert.equal(m.j,.149);
 assert.equal(m.jContributions.settling,.135);
 const energy=samples.slice(0,-1).reduce((sum,s,i)=>sum+s.out*s.out*(samples[i+1].ms-s.ms)/1000,0);
 assert(Math.abs(m.jContributions.energy-.1*energy/20000)<1e-12);
 assert.equal(m.dominantCostTerm,'settling');
 const sum=Object.values(m.jContributions).reduce((a,b)=>a+b,0);
 assert.equal(Number(sum.toFixed(4)),m.j);
});
