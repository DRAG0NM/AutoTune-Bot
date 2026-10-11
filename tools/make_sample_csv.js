#!/usr/bin/env node
/**
 * Generate a synthetic CSV fixture for replay development.
 * Uses the current simulator and a nonzero timestamp origin.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSim } from '../bridge/backends/sim.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'testdata', 'sample_step_response.csv');

// Synthetic response using the default gains and fixed noise seed.
const samples = runSim({
  gains: { AngleKp: 5, AngleKi: 0.1, AngleKd: 5 },
  target: 0,
  x0: 3,
  durationMs: 3000,
  noise: 0.05,
  seed: 20261008,
});

// Nonzero timestamp origin exercises replay time normalization.
const base = 10240;
const header = 'ms,angle,target,out,spdL,spdR,errInt';
const body = samples.map((s) => [s.ms + base, s.angle, s.target, s.out, s.spdL, s.spdR, s.errInt].join(',')).join('\n');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${header}\n${body}\n`, 'utf8');
console.log(`已生成 ${OUT}（${samples.length} 行，合成数据）`);
