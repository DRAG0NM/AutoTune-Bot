import test from 'node:test';
import assert from 'node:assert/strict';
import {runSim} from '../bridge/backends/sim.js';

test('t=0 is exact initial state and final state follows exactly N plant intervals',()=>{
  const gains={AngleKp:0,AngleKi:0,AngleKd:0};
  const rows=runSim({gains,x0:3,noise:0,durationMs:30,dtMs:10,sampleMs:10});
  let theta=3*Math.PI/180,omega=0;
  const expected=[3];
  for(let i=0;i<3;i++) {
    omega+=(9.81/.15*Math.sin(theta)-4.3*omega)*.01;
    theta+=omega*.01;expected.push(Number((theta*180/Math.PI).toFixed(3)));
  }
  assert.deepEqual(rows.map(r=>r.ms),[0,10,20,30]);
  assert.deepEqual(rows.map(r=>r.angle),expected);
  assert.equal(rows.termination.atMs,30);
});

test('control and disturbance act on the following interval, terminal does not integrate',()=>{
  const gains={AngleKp:0,AngleKi:1,AngleKd:0};
  const rows=runSim({gains,x0:3,noise:0,durationMs:20,dtMs:10,sampleMs:10});
  assert.equal(rows[0].out,3);assert.equal(rows[0].errInt,-3);
  const acceleration=9.81/.15*Math.sin(3*Math.PI/180)-20/(180/Math.PI)*3*Math.cos(3*Math.PI/180);
  assert.equal(rows[1].angle,Number((3+acceleration*.0001*180/Math.PI).toFixed(3)));
  assert.equal(rows[2].errInt,rows[1].errInt);
  assert.equal(rows[2].out,rows[1].out);
  const impulse=runSim({gains:{AngleKp:0,AngleKi:0,AngleKd:0},x0:0,noise:0,durationMs:30,
    dtMs:10,sampleMs:10,disturbance:{atMs:10,impulseDegPerSec:10}});
  assert.equal(impulse[1].angle,0);
  assert.equal(impulse[2].angle,.096); // 10deg/s, one 10ms step with 4.3/s damping
  for(const bad of [{durationMs:25},{sampleMs:15},{disturbance:{atMs:15,impulseDegPerSec:10}},
    {disturbance:{atMs:30,impulseDegPerSec:10}}])
    assert.throws(()=>runSim({durationMs:30,dtMs:10,sampleMs:10,...bad}));
});
