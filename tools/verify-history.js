#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadHistoricalVersion, versionForCampaign } from './historical-runtime.js';
import { csvRows } from './verify-evidence-figures.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'evidence/05_validation');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const normalized = v => JSON.parse(JSON.stringify(v, (_, x) => typeof x === 'number' && !Number.isFinite(x) ? Number.isNaN(x) ? null : String(x) : x));
const versions = new Map();
for (const v of ['v2.3','stage-a','stage-b','stage-c','stage-d','stage-d2']) versions.set(v, await loadHistoricalVersion(v));
let runs = 0;
const campaigns = [];
for (const id of fs.readdirSync(evidence).filter(id => fs.existsSync(path.join(evidence, id, 'index.jsonl')))) {
  const records = fs.readFileSync(path.join(evidence, id, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const { simulator, metrics } = versions.get(versionForCampaign(id));
  for (const r of records) {
    const s = r.meta.sim;
    const event = s.disturbanceEvent;
    const disturbance = event ? { atMs: event.atMs, impulseDegPerSec: event.amplitude }
      : s.disturbance == null ? null : { atMs: r.durationMs / 2, impulseDegPerSec: s.disturbance };
    const samples = simulator.runSim({ gains: r.gains, durationMs: r.durationMs, target: r.target,
      x0: s.x0, seed: s.seed, disturbance, simProfile: s.simProfile, simController: s.controller });
    assert.deepEqual(normalized([...samples]), normalized(csvRows(path.join(evidence, id, r.csv))), `${id}/${r.runId}: telemetry`);
    const m = normalized(metrics.computeMetrics(samples, { ...r.evaluation.metrics, weights: r.evaluation.weights, termination: s.termination }));
    assert.deepEqual(m, r.metrics, `${id}/${r.runId}: full metrics`);
    runs++;
  }
  campaigns.push({ id, version: versionForCampaign(id), reproduced: records.length });
}
const legacy = versions.get('v2.3');
const grid = json(path.join(evidence, 'grid-v2.3-ki0.json'));
for (const r of grid.rows) {
  const m = normalized(legacy.metrics.computeMetrics(legacy.simulator.runSim({ gains: { AngleKp:r.kp, AngleKi:grid.ki, AngleKd:r.kd }, durationMs:grid.dur, x0:grid.x0, seed:grid.seed, target:0 }), grid.metricOpts));
  for (const k of ['fail','converged','overshoot','settlingMs','osc','ssErr','energy','j']) assert.deepEqual(m[k], r[k], `Grid ${r.kp}/${r.kd}: ${k}`);
}
const selftest = json(path.join(root, 'evidence/06_testcases/selftest-v2.3.json'));
for (const c of selftest.cases) {
  const samples = c.gains ? legacy.simulator.runSim({ gains:c.gains, durationMs:grid.dur }) : csvRows(path.join(root,'testdata/sample_step_response.csv'));
  assert.deepEqual(normalized(legacy.metrics.computeMetrics(samples, grid.metricOpts)), c.metrics, `Selftest: ${c.key}`);
}
console.log(JSON.stringify({ verified:true, campaigns, telemetryRunsReproduced:runs, gridPointsReproduced:grid.rows.length, selftestCasesReproduced:selftest.cases.length }, null, 2));
