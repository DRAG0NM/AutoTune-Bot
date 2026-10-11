#!/usr/bin/env node
// 只读核验图表输入；不运行 trial，不改历史指标或 CSV。
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadHistoricalVersion, historicalManifest } from './historical-runtime.js'
import { diagnose } from '../evidence/versions/stage-d2/bridge/lib/diagnostics.js'

const historicalRuntime = await loadHistoricalVersion('stage-d2')
const { computeMetrics } = historicalRuntime.metrics
const { runSim } = historicalRuntime.simulator

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidence = path.join(root, 'evidence/05_validation')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const normalized = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'number' && !Number.isFinite(v) ? Number.isNaN(v) ? null : String(v) : v))

export function csvRows(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const headers = lines.shift().split(',')
  return lines.map(line => {
    const cells = line.split(',')
    assert.equal(cells.length, headers.length, `${file}: CSV column count`)
    assert(cells.every(c => c.trim() && Number.isFinite(Number(c))), `${file}: nonnumeric CSV`)
    return Object.fromEntries(headers.map((h, i) => [h, Number(cells[i])]))
  })
}

export function verifyFigureInputs() {
  // 已逐一检查七份冻结源码包；指标实现全部为此身份，诊断实现六份一致。
  const frozen = {
    metrics: 'e7b8d65520e7ee8d350210f4d0e4a2c6dbf156d608d2ebabe3b47457b5317d63',
    diagnostics: '78ee02253d755d5c2e36cc6007b60ca7273fbae2b382deac16179f64e3273ba1',
  }
  for (const [name, expected] of Object.entries(frozen)) assert.equal(historicalRuntime.entry.files.find(f => f.path === `bridge/lib/${name}.js`).originalSha256, expected, 'Historical evaluator identity mismatch')
  const campaigns = []
  const frozenSimulation = {
    'bridge/backends/sim.js': 'c4b124d8a9a038be5c27bce803fe6e62f72aa6226363fffdf9e5c350a594255e',
    'bridge/lib/sim-controller.js': 'cabb3c8c7f3cebbd7aea6bf50ca5857e5a47c4a4019baf731d8b4aeac22e7e05',
    'bridge/lib/sim-options.js': 'ae1f98b6783977d5a69922e5f886636655eb5d0f2fd48b2763d9eadafc795b21',
  }
  for (const [file, expected] of Object.entries(frozenSimulation)) assert.equal(historicalRuntime.entry.files.find(f => f.path === file).originalSha256, expected, 'Historical D2 simulator identity mismatch')
  let recordsChecked = 0, diagnosticsChecked = 0, controllerStatsChecked = 0
  for (const id of fs.readdirSync(evidence).filter(id => fs.existsSync(path.join(evidence, id, 'index.jsonl')))) {
    const dir = path.join(evidence, id)
    const summary = json(path.join(dir, 'summary.json'))
    if (id === 'agnes-stage-d2-m-baseline-20261010') continue // 无 plan 试运行不进入正式图。
    assert(summary.verified, `${id}: not verified`)
    if (id !== 'agnes-20261010-a') assert(summary.planComplete, `${id}: incomplete plan`)
    const records = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(records.length, summary.total)
    const runIds = new Set()
    for (const r of records) {
      assert(!runIds.has(r.runId), `${id}: duplicate run`); runIds.add(r.runId)
      assert.equal(path.basename(r.csv), r.csv)
      const file = path.join(dir, r.csv)
      assert.equal(hash(file), r.csvHash, `${id}: CSV hash changed`)
      const rows = csvRows(file)
      const actual = normalized(computeMetrics(rows, { ...r.evaluation.metrics, weights: r.evaluation.weights, termination: r.meta.sim.termination }))
      for (const key of ['ok','fail','converged','n','j','overshoot','settlingMs','ssErr','osc','energy','tol']) {
        assert.deepEqual(actual[key], r.metrics[key], `${id}/${r.runId}: ${key}`)
      }
      if (r.diagnostics) {
        const d = diagnose(rows, { tolerance: r.metrics.tol ?? r.evaluation.metrics.tolFloor, holdMs: r.evaluation.metrics.settleHoldMs, disturbanceAtMs: r.meta.sim.disturbanceEvent?.atMs ?? null })
        assert.deepEqual(d, r.diagnostics, `${id}/${r.runId}: diagnostics`)
        diagnosticsChecked++
      }
      if (r.meta.sim.controllerStats) {
        const s = r.meta.sim
        const simulated = runSim({ gains: r.gains, target: r.target, durationMs: r.durationMs, x0: s.x0, seed: s.seed, simProfile: s.simProfile, simController: s.controller, disturbance: s.disturbanceEvent ? { atMs: s.disturbanceEvent.atMs, impulseDegPerSec: s.disturbanceEvent.amplitude } : null })
        assert.deepEqual(simulated.simConfig.controllerStats, s.controllerStats, `${id}: control-loop statistics`)
        controllerStatsChecked++
      }
      recordsChecked++
    }
    const search = records.filter(r => r.decision.purpose === 'search')
    const validation = records.filter(r => r.decision.purpose === 'robustness')
    assert.equal(search.length, summary.searches)
    const maxJ = id.includes('stage-d2-t-') ? .72 : .8
    for (const r of search) assert(r.metrics.j === 'Infinity' && r.metrics.fail || typeof r.metrics.j === 'number' && r.metrics.j >= 0 && r.metrics.j <= maxJ, `${id}: search outside figure bounds`)
    assert.equal(validation.length, summary.validationCount ?? summary.robustness.length)
    const feasible = search.filter(r => !r.metrics.fail && r.metrics.converged && Number.isFinite(r.metrics.j) && (r.experimentPlan?.objective !== 'impulse-recovery' || r.diagnostics?.disturbance?.recovered))
    const best = feasible.reduce((a,b) => !a || b.metrics.j < a.metrics.j ? b : a, null)
    assert.equal(summary.best?.runId ?? null, best?.runId ?? null, `${id}: best mismatch`)
    if (summary.validationPassed !== undefined) assert.equal(summary.validationPassed, validation.every(r => !r.metrics.fail && r.metrics.converged && (!r.meta.sim.disturbanceEvent || r.diagnostics?.disturbance?.recovered)), `${id}: validation gate`)
    campaigns.push({ id, records: records.length, searches: search.length, validations: validation.length, convergedValidations: validation.filter(r => r.metrics.converged).length })
  }
  const grid = json(path.join(evidence, 'grid-v2.3-ki0.json'))
  assert.equal(grid.rows.length, grid.kps.length * grid.kds.length)
  assert.equal(new Set(grid.rows.map(r => `${r.kp}/${r.kd}`)).size, grid.rows.length)
  const best = grid.rows.filter(r => r.converged && !r.fail).sort((a,b) => a.j - b.j)[0]
  assert.deepEqual(grid.best, best)
  const selftest = json(path.join(root, 'evidence/06_testcases/selftest-v2.3.json'))
  assert(selftest.allPass)
  for (const c of selftest.cases) assert(typeof c.metrics.j === 'number' && Number.isFinite(c.metrics.j) && c.metrics.j >= 0 && c.metrics.j <= .8 || c.metrics.fail && c.metrics.j === 'Infinity', `Invalid selftest J: ${c.key}`)
  const replay = selftest.cases.filter(c => !c.gains)
  assert.equal(replay.length, 1, 'Expected one replay selftest')
  assert.deepEqual(normalized(computeMetrics(csvRows(path.join(root, 'testdata/sample_step_response.csv')), grid.metricOpts)), replay[0].metrics, 'Replay selftest metrics')
  const exploration = json(path.join(evidence, 'stage-d2-method-exploration.json'))
  assert.equal(exploration.agentGenerated, false)
  assert.equal(exploration.records.length, 162)
  for (const r of exploration.records) {
    const samples = runSim(r.options)
    assert.deepEqual(samples.simConfig, r.effectiveSim, 'Method exploration simulator configuration and statistics')
    assert.deepEqual(normalized(computeMetrics(samples)), r.metrics, 'Method exploration metrics')
    assert.deepEqual(diagnose(samples, { tolerance: r.metrics.tol ?? .1, disturbanceAtMs: r.options.disturbance?.atMs ?? null }), r.diagnostics, 'Method exploration diagnostics')
  }
  const historical = json(path.join(evidence, 'stage-a-historical-diagnostics.json'))
  const firstDir = path.join(evidence, historical.campaign)
  const firstRecords = fs.readFileSync(path.join(firstDir, 'index.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(historical.results.length, firstRecords.length)
  for (const d of historical.results) {
    const r = firstRecords.find(r => r.runId === d.runId)
    assert(r && d.csv === r.csv && d.csvHash === r.csvHash, 'Historical diagnostic identity')
    const disturbanceAtMs = d.disturbanceAtMsSource === 'legacy-half-duration' ? r.durationMs / 2 : null
    assert.deepEqual(diagnose(csvRows(path.join(firstDir, r.csv)), { tolerance: r.metrics.tol ?? r.evaluation.metrics.tolFloor, holdMs: r.evaluation.metrics.settleHoldMs, disturbanceAtMs }), d.diagnostics, 'Historical diagnostic recomputation')
  }
  return { verified: true, frozenEvaluatorHashes: frozen, frozenSimulatorHashes: frozenSimulation, publishedHistoricalModules: historicalManifest.versions['stage-d2'].files, recordsChecked, diagnosticsChecked, controllerStatsChecked, historicalDiagnosticsChecked: historical.results.length, campaigns, gridPoints: grid.rows.length, selftestCases: selftest.cases.length, replayCasesRecomputed: replay.length, explorationPointsReproduced: exploration.records.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyFigureInputs(), null, 2))
}
