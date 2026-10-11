import test from 'node:test';
import assert from 'node:assert/strict';
import {createSimController, normalizeSimController} from '../bridge/lib/sim-controller.js';
import {runSim} from '../bridge/backends/sim.js';

test('baseline controller is byte-equivalent to the default simulation', () => {
  const args = {gains:{AngleKp:6,AngleKi:0.02,AngleKd:16}, durationMs:3000, seed:20261008,
    disturbance:{atMs:1500, impulseDegPerSec:10}, simProfile:{actuatorLagMs:10}};
  assert.deepEqual(runSim(args), runSim({...args, simController:{name:'baseline'}}));
});

test('conditional integral oracle covers exact boundary, trigger, and release', () => {
  const exact = createSimController({name:'conditional-integral'});
  const a = exact.step({gains:{AngleKp:99,AngleKi:1,AngleKd:0}, error:1, measured:0, previousMeasured:0});
  assert.equal(a.uPid, 100); assert.equal(a.suppressed, false); assert.equal(a.errInt, 1);
  const trigger = createSimController({name:'conditional-integral'});
  const b = trigger.step({gains:{AngleKp:99,AngleKi:2,AngleKd:0}, error:1, measured:0, previousMeasured:0});
  assert.equal(b.uPid, 99); assert.equal(b.suppressed, true); assert.equal(b.errInt, 0);
  const c = trigger.step({gains:{AngleKp:99,AngleKi:2,AngleKd:0}, error:0, measured:0, previousMeasured:0});
  assert.equal(c.suppressed, false); assert.equal(c.errInt, 0);
  assert.equal(trigger.finish().integralSuppressedSteps, 1);
});

test('derivative filter uses the declared 20ms first-order recurrence', () => {
  const c = createSimController({name:'derivative-filter', derivativeFilterMs:20}, {dtMs:10});
  const gains = {AngleKp:0,AngleKi:0,AngleKd:1};
  assert.equal(c.step({gains,error:0,measured:3,previousMeasured:0}).uPid, -1);
  assert.ok(Math.abs(c.step({gains,error:0,measured:3,previousMeasured:3}).uPid + 2 / 3) < 1e-12);
  assert.equal(c.finish().maxAbsIntegral, 0);
});

test('controller configuration rejects invalid variants', () => {
  assert.deepEqual(normalizeSimController(), {name:'baseline', derivativeFilterMs:null});
  assert.throws(() => normalizeSimController({name:'derivative-filter', derivativeFilterMs:10}));
  assert.throws(() => normalizeSimController({name:'baseline', derivativeFilterMs:20}));
  assert.throws(() => normalizeSimController({name:'unknown'}));
});
