#!/usr/bin/env node
// Local method exploration only: pure sim calls, no CLI trials, runs/ or state writes.
// All points are emitted, including failures; this is not Agnes search evidence.
import {runSim} from '../bridge/backends/sim.js';
import {computeMetrics} from '../bridge/lib/metrics.js';
import {diagnose} from '../bridge/lib/diagnostics.js';

const controllers=['baseline','conditional-integral','derivative-filter'];
const profiles=[{actuatorLagMs:10},{deadZoneOutput:0.15},{measurementDelayMs:10},
  {noise:0.15},{controlScale:0.85,dampingScale:0.85},
  {actuatorLagMs:10,deadZoneOutput:0.15,measurementDelayMs:10,noise:0.15,controlScale:0.85,dampingScale:0.85}];
const records=[];
function probe(group,options) {
  const samples=runSim(options), metrics=computeMetrics(samples);
  records.push({group,options,effectiveSim:samples.simConfig,termination:samples.termination,metrics,
    diagnostics:diagnose(samples,{tolerance:metrics.tol??0.1,disturbanceAtMs:options.disturbance?.atMs??null})});
}
// The 4s sensitivity keeps the impulse at 1500ms; it does not use CLI's midpoint.
// These 4s values cannot be mixed with official 3s J rankings.
for(const name of controllers) for(const AngleKi of [0,0.005,0.01,0.02])
  for(const simProfile of profiles) for(const durationMs of [3000,4000])
    probe('integral-and-window-sensitivity',{gains:{AngleKp:6,AngleKi,AngleKd:16},
      durationMs,target:0,x0:3,seed:20261008,disturbance:{atMs:1500,impulseDegPerSec:10},
      simProfile,simController:{name}});
// Exercise the integral gate, with mirrored initial conditions and baseline controls.
// High-angle cases are simulation hypotheses, never car launch settings.
for(const name of controllers) for(const AngleKi of [0.02,0.05]) for(const x0 of [3,20,-20])
  probe('saturation-activation',{gains:{AngleKp:6,AngleKi,AngleKd:16},durationMs:3000,
    target:0,x0,seed:20261008,disturbance:null,simProfile:{actuatorLagMs:10},simController:{name}});
console.log(JSON.stringify({kind:'local-method-exploration',agentGenerated:false,
  limitations:['Fixed parameters, not an autonomous search','No hardware or state writes',
    'Window sensitivity uses a fixed 1500ms impulse, not the 4s CLI midpoint'],records},
  (_,v)=>typeof v==='number'&&!Number.isFinite(v)?String(v):v,2));
