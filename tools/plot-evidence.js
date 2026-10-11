#!/usr/bin/env node
'use strict'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyFigureInputs } from './verify-evidence-figures.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const evidence = path.join(root, 'evidence', '05_validation')
const outDir = path.join(evidence, 'figures')
const palette = {
  ink: '#202a35',
  muted: '#596776',
  grid: '#d8dee5',
  baseline: '#2878a5',
  conditional: '#25826e',
  filter: '#bf6b28',
  bad: '#bb4c49',
  good: '#25826e',
  white: '#ffffff',
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readIndex(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
}

function svgStart(width, height, title, description) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(title)}</title>`,
    `<desc id="desc">${esc(description)}</desc>`,
    `<rect width="100%" height="100%" fill="${palette.white}"/>`,
    `<style>svg{fill:${palette.ink}}text{font-family:Arial,"Microsoft YaHei",sans-serif}.muted{fill:${palette.muted}}.grid{stroke:${palette.grid};stroke-width:1}.axis{stroke:${palette.ink};stroke-width:1.2}.small{font-size:13px}.label{font-size:15px}.title{font-size:22px;font-weight:700}.subtitle{font-size:14px}.panel-title{font-size:16px;font-weight:700}</style>`,
  ].join('\n')
}

function svgEnd(parts) {
  return `${parts.join('\n')}\n</svg>\n`
}

function saveSvg(name, contents) {
  fs.writeFileSync(path.join(outDir, name), contents, 'utf8')
}

function parseCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const headers = lines.shift().split(',')
  return lines.map(line => {
    const cells = line.split(',')
    if (cells.length !== headers.length || cells.some(cell => cell.trim() === '' || !Number.isFinite(Number(cell)))) throw new Error(`Invalid numeric CSV: ${file}`)
    return Object.fromEntries(headers.map((header, index) => [header, Number(cells[index])]))
  })
}

function campaign(id) {
  const dir = path.join(evidence, id)
  const summary = readJson(path.join(dir, 'summary.json'))
  const records = readIndex(path.join(dir, 'index.jsonl'))
  if (!summary.verified || !summary.planComplete) throw new Error(`${id} is not verified and complete`)
  if (records.length !== summary.total) throw new Error(`${id}: index/summary count mismatch`)
  return { id, dir, summary, records }
}

function requireRunCount(data, count) {
  if (data.records.length !== count) throw new Error(`${data.id}: expected ${count} records, got ${data.records.length}`)
}

function pairedM2() {
  const baseline = campaign('agnes-stage-d2-m2-baseline-20261010')
  const conditional = campaign('agnes-stage-d2-m2-conditional-integral-20261010')
  requireRunCount(baseline, 4)
  requireRunCount(conditional, 4)
  const byKey = records => new Map(records.map(record => [`${record.decision.purpose}:${record.meta.sim.x0}:${record.meta.sim.seed}`, record]))
  const baseByKey = byKey(baseline.records)
  const ciByKey = byKey(conditional.records)
  const orderedKeys = [...baseByKey.keys()].sort((left, right) => {
    const a = baseByKey.get(left)
    const b = baseByKey.get(right)
    const aSearch = a.decision.purpose === 'search'
    const bSearch = b.decision.purpose === 'search'
    if (aSearch !== bSearch) return aSearch ? -1 : 1
    return a.meta.sim.seed - b.meta.sim.seed || a.meta.sim.x0 - b.meta.sim.x0
  })
  const pairs = orderedKeys.map(key => {
    const a = baseByKey.get(key)
    const b = ciByKey.get(key)
    if (!b) throw new Error(`Unmatched M2 scenario ${key}`)
    const ca = a.meta.sim.controller.name
    const cb = b.meta.sim.controller.name
    if (ca !== 'baseline' || cb !== 'conditional-integral') throw new Error(`Unexpected M2 controllers ${ca}/${cb}`)
    if (a.gains.AngleKp !== b.gains.AngleKp || a.gains.AngleKi !== b.gains.AngleKi || a.gains.AngleKd !== b.gains.AngleKd) throw new Error(`Unmatched M2 gains for ${key}`)
    if (a.target !== b.target || a.durationMs !== b.durationMs || a.sourceHash !== b.sourceHash || a.meta.sim.modelVersion !== b.meta.sim.modelVersion || JSON.stringify(a.meta.sim.simProfile) !== JSON.stringify(b.meta.sim.simProfile) || JSON.stringify(a.evaluation) !== JSON.stringify(b.evaluation) || a.meta.sim.disturbance !== b.meta.sim.disturbance || a.metrics.tol !== b.metrics.tol) throw new Error(`Unmatched M2 conditions for ${key}`)
    const label = `${a.decision.purpose === 'search' ? 'search' : 'valid'}  x0=${a.meta.sim.x0 > 0 ? '+' : ''}${a.meta.sim.x0}, seed=${String(a.meta.sim.seed).slice(-2)}`
    return { key, label, a, b }
  })
  if (pairs.length !== 4) throw new Error('Expected four paired M2 scenarios')
  return { baseline, conditional, pairs }
}

function lineChart({ parts, x, y, w, h, values, min, max, ticks, colorA, colorB, threshold, formatter }) {
  const left = x + 58
  const right = x + w - 15
  const top = y + 42
  const bottom = y + h - 48
  const xStep = (right - left) / (values.length - 1)
  const mapY = value => {
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Chart value ${value} outside ${min}..${max}`)
    return bottom - ((value - min) / (max - min)) * (bottom - top)
  }
  for (const tick of ticks) {
    const py = mapY(tick)
    parts.push(`<line class="grid" x1="${left}" x2="${right}" y1="${py}" y2="${py}"/>`)
    parts.push(`<text class="small muted" text-anchor="end" x="${left - 8}" y="${py + 4}">${formatter(tick)}</text>`)
  }
  if (threshold !== undefined) {
    const py = mapY(threshold.value)
    parts.push(`<line x1="${left}" x2="${right}" y1="${py}" y2="${py}" stroke="${palette.bad}" stroke-width="1.4" stroke-dasharray="6 5"/>`)
    parts.push(`<text class="small" fill="${palette.bad}" x="${right - 3}" y="${py - 6}" text-anchor="end">${esc(threshold.label)}</text>`)
  }
  parts.push(`<line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${bottom}"/>`)
  parts.push(`<line class="axis" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`)
  values.forEach((point, index) => {
    const px = left + xStep * index
    const ya = mapY(point.a)
    const yb = mapY(point.b)
    parts.push(`<line x1="${px}" x2="${px}" y1="${ya}" y2="${yb}" stroke="${palette.grid}" stroke-width="2"/>`)
    parts.push(`<circle cx="${px}" cy="${ya}" r="5" fill="${colorA}"/>`)
    parts.push(`<rect x="${px - 4.5}" y="${yb - 4.5}" width="9" height="9" fill="${colorB}"/>`)
    parts.push(`<text class="small muted" text-anchor="middle" x="${px}" y="${bottom + 17}">${index + 1}</text>`)
  })
  parts.push(`<text class="small muted" text-anchor="middle" x="${(left + right) / 2}" y="${y + h - 8}">matched scenario (see key)</text>`)
}

function makeM2MetricsFigure(data) {
  const width = 1420
  const height = 440
  const tolerance = data.pairs[0].a.metrics.tol
  if (data.pairs.some(p => p.a.metrics.tol !== tolerance || p.b.metrics.tol !== tolerance)) throw new Error('M2 tolerances must match')
  const parts = [svgStart(width, height, 'D2-M2 paired controller metrics', 'Four matched scenarios compare J, normalized reverse overshoot, and absolute tail error. Dashed limits show 30% overshoot and the recorded angle tolerance.')]
  parts.push('<text class="title" x="38" y="38">D2-M2 | 配对控制器指标</text>')
  parts.push('<text class="subtitle muted" x="38" y="62">固定 gains 6 / 0.02 / 16；sim-pressure-3；3 s；lag 10 ms；无扰动。每条线连接相同初态与 seed。</text>')
  const values = [
    { title: '综合代价 J（越低越好）', get: r => r.metrics.j, min: 0.42, max: 0.64, ticks: [0.45, 0.5, 0.55, 0.6], threshold: undefined, format: v => v.toFixed(2) },
    { title: '归一化反向过冲（%）', get: r => r.metrics.overshoot, min: 0.22, max: 0.39, ticks: [0.24, 0.28, 0.32, 0.36], threshold: { value: 0.3, label: '门槛 30%' }, format: v => (v * 100).toFixed(0) },
    { title: '末窗绝对误差（°）', get: r => Math.abs(r.metrics.ssErr), min: 0.1, max: 0.48, ticks: [0.15, 0.25, 0.35, 0.45], threshold: { value: tolerance, label: `容差 ${tolerance.toFixed(3)}°` }, format: v => v.toFixed(2) },
  ]
  const panelW = 440
  values.forEach((metric, index) => {
    const x = 35 + index * 465
    parts.push(`<text class="panel-title" x="${x + 58}" y="104">${esc(metric.title)}</text>`)
    lineChart({ parts, x, y: 94, w: panelW, h: 282, values: data.pairs.map(pair => ({ a: metric.get(pair.a), b: metric.get(pair.b) })), min: metric.min, max: metric.max, ticks: metric.ticks, colorA: palette.baseline, colorB: palette.conditional, threshold: metric.threshold, formatter: metric.format })
  })
  const legendY = 395
  parts.push(`<circle cx="55" cy="${legendY}" r="5" fill="${palette.baseline}"/><text class="small" x="67" y="${legendY + 4}">Baseline</text>`)
  parts.push(`<rect x="160" y="${legendY - 4.5}" width="9" height="9" fill="${palette.conditional}"/><text class="small" x="177" y="${legendY + 4}">Conditional integral</text>`)
  parts.push('<text class="small muted" x="420" y="399">横轴编号：1 搜索(+20°, seed08)；2 验证(-20°, seed08)；3 验证(-20°, seed09)；4 验证(+20°, seed09)</text>')
  parts.push('<text class="small muted" x="38" y="425">J 为过冲、调节时间、稳态误差与控制能量的加权综合代价；虚线标示收敛判定门槛。</text>')
  return svgEnd(parts)
}

function makeResponseFigure(data) {
  const width = 1180
  const height = 730
  const parts = [svgStart(width, height, 'D2-M2 matched angle responses', 'Absolute simulated angle error sampled every 50 milliseconds over four matched initial-angle and seed conditions. Baseline and conditional-integral use identical gains and profiles.')]
  parts.push('<text class="title" x="38" y="38">D2-M2 | 四组配对角度响应</text>')
  parts.push('<text class="subtitle muted" x="38" y="62">误差绝对值 |e|；每 50 ms 遥测采样。相同初态、seed 与模型，只改变控制器。</text>')
  const plotLeft = 91
  const plotRight = 1145
  const panelTop = 100
  const panelH = 132
  const gap = 25
  const maxY = 21
  const yMap = (value, top) => top + 24 + (maxY - value) / maxY * 82
  data.pairs.forEach((pair, index) => {
    const top = panelTop + index * (panelH + gap)
    const bottom = top + 106
    const rowsA = parseCsv(path.join(data.baseline.dir, pair.a.csv))
    const rowsB = parseCsv(path.join(data.conditional.dir, pair.b.csv))
    if (rowsA.length !== rowsB.length || rowsA.length < 2) throw new Error(`M2 response length mismatch for ${pair.key}`)
    const xMap = ms => plotLeft + ms / 3000 * (plotRight - plotLeft)
    for (const tick of [0, 5, 10, 15, 20]) {
      const py = yMap(tick, top)
      parts.push(`<line class="grid" x1="${plotLeft}" x2="${plotRight}" y1="${py}" y2="${py}"/>`)
      parts.push(`<text class="small muted" text-anchor="end" x="${plotLeft - 10}" y="${py + 4}">${tick}</text>`)
    }
    parts.push(`<line class="axis" x1="${plotLeft}" x2="${plotLeft}" y1="${top + 24}" y2="${bottom}"/>`)
    parts.push(`<line class="axis" x1="${plotLeft}" x2="${plotRight}" y1="${bottom}" y2="${bottom}"/>`)
    for (const tick of [0, 1000, 2000, 3000]) {
      const px = xMap(tick)
      parts.push(`<line class="grid" x1="${px}" x2="${px}" y1="${top + 24}" y2="${bottom}"/>`)
      if (index === data.pairs.length - 1) parts.push(`<text class="small muted" text-anchor="middle" x="${px}" y="${bottom + 18}">${tick}</text>`)
    }
    const tolY = yMap(pair.a.metrics.tol, top)
    parts.push(`<line x1="${plotLeft}" x2="${plotRight}" y1="${tolY}" y2="${tolY}" stroke="${palette.bad}" stroke-width="1.2" stroke-dasharray="5 4"/>`)
    const pathFor = rows => rows.map((row, i) => `${i ? 'L' : 'M'}${xMap(row.ms).toFixed(2)},${yMap(Math.abs(row.angle - row.target), top).toFixed(2)}`).join(' ')
    parts.push(`<path d="${pathFor(rowsA)}" fill="none" stroke="${palette.baseline}" stroke-width="2"/>`)
    parts.push(`<path d="${pathFor(rowsB)}" fill="none" stroke="${palette.conditional}" stroke-width="2"/>`)
    parts.push(`<text class="panel-title" x="${plotLeft}" y="${top + 15}">${index + 1}. ${esc(pair.label)}</text>`)
    if (index === 0) parts.push(`<text class="small" x="${plotRight - 4}" y="${tolY - 4}" text-anchor="end" fill="${palette.bad}">容差 |e|≤${pair.a.metrics.tol.toFixed(3)}°</text>`)
  })
  parts.push(`<text class="small muted" transform="translate(26 ${panelTop + 250}) rotate(-90)" text-anchor="middle">|angle − target|（°）</text>`)
  parts.push('<text class="small muted" x="605" y="721" text-anchor="middle">仿真时间（ms）</text>')
  parts.push(`<line x1="810" x2="840" y1="77" y2="77" stroke="${palette.baseline}" stroke-width="2.5"/><text class="small" x="847" y="81">Baseline</text>`)
  parts.push(`<line x1="950" x2="980" y1="77" y2="77" stroke="${palette.conditional}" stroke-width="2.5"/><text class="small" x="987" y="81">Conditional integral</text>`)
  return svgEnd(parts)
}

function makeSearchFigure() {
  const configs = [
    ['agnes-stage-d2-t-baseline-20261010', 'Baseline', palette.baseline],
    ['agnes-stage-d2-t-conditional-integral-20261010', 'Conditional integral', palette.conditional],
    ['agnes-stage-d2-t-derivative-filter-20261010', 'Derivative filter 20 ms', palette.filter],
  ]
  const data = configs.map(([id, label, color]) => {
    const c = campaign(id)
    const points = c.records.filter(row => row.decision.purpose === 'search')
    const validations = c.records.filter(row => row.decision.purpose === 'robustness')
    const bestId = c.summary.best?.runId
    if (!points.length || !bestId) throw new Error(`${id}: missing search or feasible best`)
    if (validations.length !== c.summary.validationCount) throw new Error(`${id}: validation count mismatch`)
    if (points.length !== c.summary.searches) throw new Error(`${id}: search count mismatch`)
    return { label, color, points, validations, bestId, validationPassed: c.summary.validationPassed }
  })
  const width = 1250
  const height = 790
  const parts = [svgStart(width, height, 'D2-T autonomous search trajectories', 'Three independent search campaigns show J by search evaluation. Circles are converged points, triangles are non-converged points, and a ring highlights each campaign best feasible point. Validation success counts are shown separately.')]
  parts.push('<text class="title" x="40" y="40">D2-T | 自主搜索轨迹与验证结果</text>')
  parts.push('<text class="subtitle muted" x="40" y="64">每个控制器单独显示搜索序列；实心圆为收敛候选，三角为未收敛候选，粗环标记该批最佳可行点。</text>')
  const chartX = 116
  const chartW = 1085
  const top = 100
  const panelH = 175
  const panelGap = 42
  const yMin = 0.25
  const yMax = 0.72
  data.forEach((series, si) => {
    const py = top + si * (panelH + panelGap)
    const y0 = py + 27
    const y1 = py + panelH - 24
    const x0 = chartX
    const x1 = chartX + chartW
    const xMap = index => x0 + (index - 1) / Math.max(1, series.points.length - 1) * (x1 - x0)
    const yMap = value => y1 - (value - yMin) / (yMax - yMin) * (y1 - y0)
    parts.push(`<text class="panel-title" x="40" y="${py + 5}">${esc(series.label)}</text>`)
    parts.push(`<text class="small muted" x="${x1}" y="${py + 5}" text-anchor="end">验证 ${series.validations.filter(row => row.metrics.converged).length}/${series.validations.length} 收敛${series.validationPassed ? ' | 批次通过' : ' | 批次未通过'}</text>`)
    for (const tick of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      if (tick < yMin || tick > yMax) continue
      const y = yMap(tick)
      parts.push(`<line class="grid" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`)
      parts.push(`<text class="small muted" text-anchor="end" x="${x0 - 10}" y="${y + 4}">${tick.toFixed(1)}</text>`)
    }
    parts.push(`<line class="axis" x1="${x0}" x2="${x0}" y1="${y0}" y2="${y1}"/>`)
    parts.push(`<line class="axis" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/>`)
    if (si === data.length - 1) series.points.forEach((_, i) => {
      const x = xMap(i + 1)
      parts.push(`<text class="small muted" text-anchor="middle" x="${x}" y="${y1 + 19}">${i + 1}</text>`)
    })
    series.points.forEach((point, index) => {
      const x = xMap(index + 1)
      const y = yMap(point.metrics.j)
      const best = point.runId === series.bestId
      if (index) {
        const prev = series.points[index - 1]
        parts.push(`<line x1="${xMap(index)}" y1="${yMap(prev.metrics.j)}" x2="${x}" y2="${y}" stroke="${series.color}" stroke-width="1.5" opacity="0.48"/>`)
      }
      if (point.metrics.converged) {
        parts.push(`<circle cx="${x}" cy="${y}" r="${best ? 8 : 5}" fill="${series.color}" stroke="${best ? palette.ink : palette.white}" stroke-width="${best ? 2.5 : 1.4}"/>`)
      } else {
        parts.push(`<path d="M ${x} ${y - (best ? 8 : 6)} L ${x + (best ? 8 : 6)} ${y + (best ? 7 : 5)} L ${x - (best ? 8 : 6)} ${y + (best ? 7 : 5)} Z" fill="${palette.white}" stroke="${series.color}" stroke-width="2"/>`)
      }
      parts.push(`<text class="small muted" text-anchor="middle" x="${x}" y="${y - 11}">${index + 1}</text>`)
    })
    const best = series.points.find(point => point.runId === series.bestId)
    parts.push(`<text class="small" x="${chartX}" y="${py + panelH + 17}" fill="${series.color}">最佳可行: ${best.gains.AngleKp}/${best.gains.AngleKi}/${best.gains.AngleKd}  J=${best.metrics.j.toFixed(4)}</text>`)
  })
  parts.push('<text class="small muted" transform="translate(42 420) rotate(-90)" text-anchor="middle">综合代价 J（越低越好）</text>')
  parts.push('<text class="small muted" x="660" y="774" text-anchor="middle">搜索评价顺序（不含后续 robustness validation）</text>')
  parts.push(`<circle cx="42" cy="746" r="5" fill="${palette.baseline}"/><text class="small" x="53" y="750">收敛</text>`)
  parts.push(`<path d="M 129 740 L 135 751 L 123 751 Z" fill="white" stroke="${palette.bad}" stroke-width="1.7"/><text class="small" x="141" y="750">未收敛</text>`)
  parts.push('<text class="small muted" x="250" y="750">连线表示候选的试验顺序；粗环标记最佳可行点；各面板右上角列出后续验证结果。</text>')
  return svgEnd(parts)
}

function mixColor(a, b, ratio) {
  const parse = value => value.match(/[0-9a-f]{2}/gi).map(byte => parseInt(byte, 16))
  const aa = parse(a)
  const bb = parse(b)
  const rgb = aa.map((value, index) => Math.round(value + (bb[index] - value) * ratio))
  return `#${rgb.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

function makeGridFigure() {
  const grid = readJson(path.join(evidence, 'grid-v2.3-ki0.json'))
  if (grid.rows.length !== grid.kps.length * grid.kds.length) throw new Error('Grid result count does not match declared axes')
  const width = 1040
  const height = 625
  const x0 = 220
  const y0 = 150
  const cellW = 112
  const cellH = 53
  const gapX = 8
  const gapY = 9
  const finite = grid.rows.filter(row => Number.isFinite(Number(row.j))).map(row => Number(row.j))
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  const parts = [svgStart(width, height, 'v2.3 Ki zero grid search', 'Thirty-six simulated grid candidates for Ki zero. Kp and Kd form the heatmap axes; hard falls are marked separately, and the lowest converged objective is highlighted.')]
  parts.push('<text class="title" x="40" y="40">v2.3 网格搜索 | Ki=0</text>')
  parts.push(`<text class="subtitle muted" x="40" y="65">${grid.rows.length} 个固定种子候选；target=0°，x0=${grid.x0}°，duration=${grid.dur}ms，seed=${grid.seed}。单元格显示 J；摔倒标记为 FALL。</text>`)
  parts.push(`<text class="label" x="${x0 + ((cellW + gapX) * grid.kds.length - gapX) / 2}" y="118" text-anchor="middle">AngleKd</text>`)
  parts.push(`<text class="label" transform="translate(118 ${y0 + ((cellH + gapY) * grid.kps.length - gapY) / 2}) rotate(-90)" text-anchor="middle">AngleKp</text>`)
  grid.kds.forEach((kd, column) => {
    const x = x0 + column * (cellW + gapX) + cellW / 2
    parts.push(`<text class="label muted" text-anchor="middle" x="${x}" y="140">${kd}</text>`)
  })
  grid.kps.forEach((kp, rowIndex) => {
    const y = y0 + rowIndex * (cellH + gapY)
    parts.push(`<text class="label muted" text-anchor="end" x="${x0 - 13}" y="${y + cellH / 2 + 5}">${kp}</text>`)
    grid.kds.forEach((kd, column) => {
      const result = grid.rows.find(item => item.kp === kp && item.kd === kd)
      if (!result) throw new Error(`Missing grid point ${kp}/${kd}`)
      const x = x0 + column * (cellW + gapX)
      const isFall = result.fail
      const j = Number(result.j)
      const colorRatio = Number.isFinite(j) ? (j - min) / Math.max(0.0001, max - min) : 1
      const fill = isFall ? '#f1dddd' : mixColor('#d9eee6', '#f1d3cf', colorRatio)
      const isBest = grid.best?.kp === kp && grid.best?.kd === kd
      parts.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="2" fill="${fill}" stroke="${isBest ? palette.ink : palette.grid}" stroke-width="${isBest ? 3 : 1}"/>`)
      parts.push(`<text class="label" text-anchor="middle" x="${x + cellW / 2}" y="${y + 23}" font-weight="${isBest ? 700 : 400}">${isFall ? 'FALL' : `J ${j.toFixed(3)}`}</text>`)
      parts.push(`<text class="small muted" text-anchor="middle" x="${x + cellW / 2}" y="${y + 42}">${isFall ? 'fail' : result.converged ? '收敛' : '未收敛'}${isBest ? ' | 最优' : ''}</text>`)
    })
  })
  parts.push('<text class="small muted" x="40" y="575">颜色表示 J：绿色较低、红色较高；FALL 表示摔倒；深色边框标记网格内最低 J 的收敛点。</text>')
  parts.push(`<text class="small" x="40" y="602">最低收敛点：Kp=${grid.best.kp}, Ki=${grid.ki}, Kd=${grid.best.kd}, J=${Number(grid.best.j).toFixed(4)}（共 ${grid.rows.filter(row => row.converged).length} 个收敛点）</text>`)
  return svgEnd(parts)
}

function makeSelftestFigure() {
  const report = readJson(path.join(root, 'evidence', '06_testcases', 'selftest-v2.3.json'))
  const width = 1100
  const rowH = 39
  const top = 120
  const height = top + report.cases.length * rowH + 100
  const x0 = 355
  const x1 = 880
  const maxJ = 0.8
  const xMap = j => x0 + Math.min(j, maxJ) / maxJ * (x1 - x0)
  const parts = [svgStart(width, height, 'v2.3 selftest case outcomes', 'Nine selftest cases shown by objective J where finite, with distinct markers for converged, non-converged, and expected hard-fall cases. The selftest suite passed all expected assertions.')]
  parts.push(`<text class="title" x="40" y="40">v2.3 selftest | ${report.cases.length} 个行为样例</text>`)
  parts.push(`<text class="subtitle muted" x="40" y="65">allPass=${report.allPass}；横轴为综合代价 J；右侧为收敛状态及运行结果。</text>`)
  parts.push(`<line class="axis" x1="${x0}" x2="${x1}" y1="${top - 10}" y2="${top - 10}"/>`)
  for (const tick of [0, 0.2, 0.4, 0.6, 0.8]) {
    const x = xMap(tick)
    parts.push(`<line class="grid" x1="${x}" x2="${x}" y1="${top - 10}" y2="${top + rowH * report.cases.length - 5}"/>`)
    parts.push(`<text class="small muted" text-anchor="middle" x="${x}" y="${top - 19}">${tick.toFixed(1)}</text>`)
  }
  report.cases.forEach((item, index) => {
    const y = top + index * rowH + 10
    const m = item.metrics
    const isFall = m.fail
    const j = Number(m.j)
    const color = isFall ? palette.bad : m.converged ? palette.good : palette.filter
    parts.push(`<text class="small" text-anchor="end" x="${x0 - 16}" y="${y + 4}">${esc(item.key)}</text>`)
    if (Number.isFinite(j)) {
      parts.push(`<circle cx="${xMap(j)}" cy="${y}" r="6" fill="${color}"/>`)
      parts.push(`<text class="small muted" x="${xMap(j) + 10}" y="${y + 4}">J=${j.toFixed(4)}</text>`)
    } else {
      parts.push(`<path d="M ${x1 - 4} ${y - 7} L ${x1 + 4} ${y + 7} M ${x1 + 4} ${y - 7} L ${x1 - 4} ${y + 7}" stroke="${color}" stroke-width="2.5"/>`)
      parts.push(`<text class="small" x="${x1 + 13}" y="${y + 4}" fill="${color}">J=∞</text>`)
    }
    parts.push(`<text class="small muted" x="930" y="${y + 4}">${m.converged ? '收敛' : isFall ? '预期硬失败' : '未收敛'} | ${m.ok ? 'ok' : 'fail'}</text>`)
    if (index < report.cases.length - 1) parts.push(`<line class="grid" x1="40" x2="1060" y1="${y + 19}" y2="${y + 19}"/>`)
  })
  parts.push('<text class="small muted" x="40" y="' + (height - 47) + '">绿色：收敛；橙色：未收敛；红色叉号：硬失败、J=∞；allPass 汇总各样例是否符合预期行为。</text>')
  return svgEnd(parts)
}

function makeEarlySearchFigure() {
  const campaigns = [
    ['agnes-20261010-a', '先期搜索 | v2.3', '公开先验周边；10 个 search 点'],
    ['agnes-stage-a-20261010', 'Stage A | 冲量恢复目标', 'sim 基线；6 个 search 点'],
    ['agnes-stage-b-20261010', 'Stage B | 时序修正', 'sim-timing-2；4 个 search 点'],
    ['agnes-stage-c-20261010', 'Stage C | 压力模型', 'sim-pressure-3；4 个 search 点'],
  ]
  const series = campaigns.map(([id, label, detail]) => {
    const dir = path.join(evidence, id)
    const summary = readJson(path.join(dir, 'summary.json'))
    const records = readIndex(path.join(dir, 'index.jsonl')).filter(row => row.decision.purpose === 'search')
    if (!summary.verified || records.length !== summary.searches) throw new Error(`${id}: invalid search evidence`)
    return { id, label, detail, summary, records }
  })
  const width = 1250
  const panelH = 156
  const height = 130 + series.length * panelH + 90
  const x0 = 132
  const x1 = 1195
  const yMax = 0.8
  const parts = [svgStart(width, height, 'early autonomous search histories', 'Four search histories for the initial v2.3 campaign and Stages A, B, and C. Panel labels identify model and search objective. Markers indicate convergence and hard failures.')]
  parts.push('<text class="title" x="40" y="40">早期 Agnes 搜索轨迹 | A–C</text>')
  parts.push('<text class="subtitle muted" x="40" y="64">各面板按试验顺序展示搜索候选；点旁数字为轮次，连线表示搜索路径，模型与目标见面板标题。</text>')
  series.forEach((s, panel) => {
    const top = 105 + panel * panelH
    const bottom = top + 108
    const xMap = index => x0 + (index - 1) / Math.max(1, s.records.length - 1) * (x1 - x0)
    const yMap = j => bottom - Math.min(j, yMax) / yMax * 86
    parts.push(`<text class="panel-title" x="40" y="${top + 4}">${esc(s.label)}</text>`)
    parts.push(`<text class="small muted" x="${x1}" y="${top + 4}" text-anchor="end">${esc(s.detail)}</text>`)
    for (const tick of [0, 0.2, 0.4, 0.6, 0.8]) {
      const y = yMap(tick)
      parts.push(`<line class="grid" x1="${x0}" x2="${x1}" y1="${y}" y2="${y}"/>`)
      parts.push(`<text class="small muted" text-anchor="end" x="${x0 - 8}" y="${y + 4}">${tick.toFixed(1)}</text>`)
    }
    parts.push(`<line class="axis" x1="${x0}" x2="${x0}" y1="${top + 16}" y2="${bottom}"/>`)
    parts.push(`<line class="axis" x1="${x0}" x2="${x1}" y1="${bottom}" y2="${bottom}"/>`)
    s.records.forEach((record, index) => {
      const x = xMap(index + 1)
      const j = Number(record.metrics.j)
      const isFinite = Number.isFinite(j)
      const y = isFinite ? yMap(j) : top + 17
      if (index && Number.isFinite(Number(s.records[index - 1].metrics.j)) && isFinite) {
        parts.push(`<line x1="${xMap(index)}" y1="${yMap(Number(s.records[index - 1].metrics.j))}" x2="${x}" y2="${y}" stroke="${palette.baseline}" stroke-width="1.5" opacity="0.55"/>`)
      }
      if (record.metrics.fail) {
        parts.push(`<path d="M ${x - 6} ${y - 6} L ${x + 6} ${y + 6} M ${x + 6} ${y - 6} L ${x - 6} ${y + 6}" stroke="${palette.bad}" stroke-width="2.2"/>`)
      } else if (record.metrics.converged) {
        parts.push(`<circle cx="${x}" cy="${y}" r="5.5" fill="${palette.good}"/>`)
      } else {
        parts.push(`<path d="M ${x} ${y - 6} L ${x + 6} ${y + 5} L ${x - 6} ${y + 5} Z" fill="white" stroke="${palette.filter}" stroke-width="1.8"/>`)
      }
      parts.push(`<text class="small muted" text-anchor="middle" x="${x}" y="${isFinite ? y - 9 : y + 19}">${index + 1}${isFinite ? '' : ' ∞'}</text>`)
    })
  })
  parts.push('<text class="small muted" transform="translate(24 420) rotate(-90)" text-anchor="middle">综合代价 J（越低越好）</text>')
  parts.push(`<circle cx="48" cy="${height - 37}" r="5" fill="${palette.good}"/><text class="small" x="59" y="${height - 33}">收敛</text>`)
  parts.push(`<path d="M 123 ${height - 43} L 129 ${height - 32} L 117 ${height - 32} Z" fill="white" stroke="${palette.filter}" stroke-width="1.5"/><text class="small" x="137" y="${height - 33}">未收敛</text>`)
  parts.push(`<path d="M 225 ${height - 42} L 235 ${height - 32} M 235 ${height - 42} L 225 ${height - 32}" stroke="${palette.bad}" stroke-width="2"/><text class="small" x="243" y="${height - 33}">硬失败 / J=∞</text>`)
  return svgEnd(parts)
}

function validationLabel(id) {
  const labels = {
    'agnes-20261010-a': '先期 A · v2.3',
    'agnes-stage-a-20261010': 'Stage A · 冲量目标',
    'agnes-stage-b-20261010': 'Stage B · 时序',
    'agnes-stage-c-20261010': 'Stage C · 压力模型',
    'agnes-stage-d-baseline-20261010-agent': 'Stage D · baseline',
    'agnes-stage-d-conditional-integral-20261010-agent': 'Stage D · 条件积分',
    'agnes-stage-d-derivative-filter-20261010-agent': 'Stage D · 微分滤波',
    'agnes-stage-d2-t-baseline-20261010': 'D2-T · baseline',
    'agnes-stage-d2-t-conditional-integral-20261010': 'D2-T · 条件积分',
    'agnes-stage-d2-t-derivative-filter-20261010': 'D2-T · 微分滤波',
    'agnes-stage-d2-m2-baseline-20261010': 'D2-M2 · baseline',
    'agnes-stage-d2-m2-conditional-integral-20261010': 'D2-M2 · 条件积分',
  }
  return labels[id]
}

function makeValidationScorecard() {
  const ids = Object.keys({
    'agnes-20261010-a': 1,
    'agnes-stage-a-20261010': 1,
    'agnes-stage-b-20261010': 1,
    'agnes-stage-c-20261010': 1,
    'agnes-stage-d-baseline-20261010-agent': 1,
    'agnes-stage-d-conditional-integral-20261010-agent': 1,
    'agnes-stage-d-derivative-filter-20261010-agent': 1,
    'agnes-stage-d2-t-baseline-20261010': 1,
    'agnes-stage-d2-t-conditional-integral-20261010': 1,
    'agnes-stage-d2-t-derivative-filter-20261010': 1,
    'agnes-stage-d2-m2-baseline-20261010': 1,
    'agnes-stage-d2-m2-conditional-integral-20261010': 1,
  })
  const rows = ids.map(id => {
    const dir = path.join(evidence, id)
    const summary = readJson(path.join(dir, 'summary.json'))
    const validations = readIndex(path.join(dir, 'index.jsonl')).filter(row => row.decision.purpose === 'robustness')
    if (!summary.verified || !validationLabel(id) || !validations.length) throw new Error(`${id}: missing validation evidence`)
    return { id, label: validationLabel(id), validations }
  })
  const width = 1300
  const rowH = 36
  const top = 120
  const height = top + rows.length * rowH + 115
  const x0 = 500
  const cellStep = 84
  const maxCells = Math.max(...rows.map(row => row.validations.length))
  const parts = [svgStart(width, height, 'campaign validation convergence scorecard', 'Converged and non-converged robustness validation runs across formal campaigns. Each campaign is shown separately because its model and success gate may differ.')]
  parts.push('<text class="title" x="40" y="40">Campaign 验证收敛情况</text>')
  parts.push('<text class="subtitle muted" x="40" y="64">每个圆点代表一条 robustness 验证；case 编号为各批次内部顺序；右侧显示收敛数 / 验证总数。</text>')
  for (let column = 0; column < maxCells; column++) {
    const x = x0 + column * cellStep
    parts.push(`<text class="small muted" text-anchor="middle" x="${x}" y="98">case ${column + 1}</text>`)
  }
  rows.forEach((row, ri) => {
    const y = top + ri * rowH
    parts.push(`<text class="small" text-anchor="end" x="${x0 - 22}" y="${y + 4}">${esc(row.label)}</text>`)
    row.validations.forEach((record, index) => {
      const x = x0 + index * cellStep
      const color = record.metrics.converged ? palette.good : palette.bad
      parts.push(`<circle cx="${x}" cy="${y}" r="9" fill="${color}"/>`)
      parts.push(`<text class="small" text-anchor="middle" x="${x}" y="${y + 4}" fill="white">${record.metrics.converged ? '✓' : '×'}</text>`)
    })
    const passed = row.validations.filter(record => record.metrics.converged).length
    parts.push(`<text class="small" x="${x0 + maxCells * cellStep + 10}" y="${y + 4}">${passed}/${row.validations.length}</text>`)
    parts.push(`<line class="grid" x1="40" x2="1270" y1="${y + 17}" y2="${y + 17}"/>`)
  })
  parts.push(`<circle cx="65" cy="${height - 46}" r="8" fill="${palette.good}"/><text class="small" x="80" y="${height - 42}">收敛</text>`)
  parts.push(`<circle cx="150" cy="${height - 46}" r="8" fill="${palette.bad}"/><text class="small" x="165" y="${height - 42}">未收敛</text>`)
  return svgEnd(parts)
}

function makeOriginalDFigure() {
  const definitions = [
    ['agnes-stage-d-baseline-20261010-agent', 'Baseline', palette.baseline],
    ['agnes-stage-d-conditional-integral-20261010-agent', 'Conditional integral', palette.conditional],
    ['agnes-stage-d-derivative-filter-20261010-agent', 'Derivative filter 20 ms', palette.filter],
  ]
  const groups = definitions.map(([id, label, color]) => {
    const records = campaign(id).records
    if (records.length !== 6 || records.some(row => row.metrics.converged)) throw new Error(`${id}: unexpected original D result set`)
    return { label, color, records }
  })
  const key = record => JSON.stringify({ purpose: record.decision.purpose, profile: record.meta.sim.simProfile, disturbance: record.meta.sim.disturbance, x0: record.meta.sim.x0, seed: record.meta.sim.seed, gains: record.gains, target: record.target, duration: record.durationMs, evaluation: record.evaluation, sourceHash: record.sourceHash })
  const labels = record => {
    const p = record.meta.sim.simProfile
    if (record.decision.purpose === 'search') return 'Search\nlag 10'
    if (p.actuatorLagMs && p.deadZoneOutput && p.measurementDelayMs && p.noise > 0.05 && p.controlScale < 1) return 'Combined'
    if (p.deadZoneOutput) return 'Dead zone\n0.15'
    if (p.measurementDelayMs) return 'Delay\n10 ms'
    if (p.noise > 0.05) return 'Noise\n0.15'
    if (p.controlScale < 1) return p.actuatorLagMs ? 'Combined' : 'Scale\n0.85'
    return 'Combined'
  }
  const baseKeys = groups[0].records.map(key)
  for (const group of groups.slice(1)) if (group.records.map(key).join('|') !== baseKeys.join('|')) throw new Error('Original D controller scenarios do not match')
  const width = 1320
  const height = 800
  const left = 112
  const right = 1285
  const panelY = [105, 315, 525]
  const plotTopOffset = 38
  const plotBottomOffset = 155
  const scenarioX = index => left + index / 5 * (right - left)
  const panels = [
    { title: '归一化反向过冲（%）', value: r => r.metrics.overshoot, min: 0.25, max: 0.55, ticks: [0.3, 0.4, 0.5], threshold: 0.3, format: v => (100 * v).toFixed(0), gate: '门槛 30%' },
    { title: '末窗绝对误差（°）', value: r => Math.abs(r.metrics.ssErr), min: 0.08, max: 0.36, ticks: [0.1, 0.2, 0.3], threshold: 0.1, format: v => v.toFixed(2), gate: '门槛 0.10°' },
    { title: '施扰后恢复时间（ms）', value: r => r.diagnostics.disturbance.recoveryMs, min: 0, max: 1500, ticks: [0, 500, 1000, 1500], threshold: undefined, format: v => String(v) },
  ]
  const parts = [svgStart(width, height, 'original D convergence criterion breakdown', 'Original D paired scenarios: normalized reverse overshoot, absolute tail error and impulse recovery. Crosses in recovery panels mean no qualifying recovery within the observation window.')]
  parts.push('<text class="title" x="40" y="40">原 D 结构对照 | 收敛判据拆解</text>')
  parts.push('<text class="subtitle muted" x="40" y="64">固定 gains 6 / 0.02 / 16；同一 sim-pressure-3 工况；18/18 条均未收敛。恢复图中的叉号表示窗口内未达到带内保持要求。</text>')
  panels.forEach((panel, panelIndex) => {
    const y = panelY[panelIndex]
    const plotTop = y + plotTopOffset
    const plotBottom = y + plotBottomOffset
    const yMap = value => plotBottom - (value - panel.min) / (panel.max - panel.min) * (plotBottom - plotTop)
    parts.push(`<text class="panel-title" x="${left}" y="${y + 18}">${panel.title}</text>`)
    for (const tick of panel.ticks) {
      const py = yMap(tick)
      parts.push(`<line class="grid" x1="${left}" x2="${right}" y1="${py}" y2="${py}"/>`)
      parts.push(`<text class="small muted" text-anchor="end" x="${left - 9}" y="${py + 4}">${panel.format(tick)}</text>`)
    }
    if (panel.threshold !== undefined) {
    const ty = yMap(panel.threshold)
    parts.push(`<line x1="${left}" x2="${right}" y1="${ty}" y2="${ty}" stroke="${palette.bad}" stroke-width="1.4" stroke-dasharray="6 5"/>`)
    parts.push(`<text class="small" x="${right - 3}" y="${ty - 5}" text-anchor="end" fill="${palette.bad}">${panel.gate}</text>`)
    }
    parts.push(`<line class="axis" x1="${left}" x2="${left}" y1="${plotTop}" y2="${plotBottom}"/>`)
    parts.push(`<line class="axis" x1="${left}" x2="${right}" y1="${plotBottom}" y2="${plotBottom}"/>`)
    groups.forEach((group, gi) => group.records.forEach((record, index) => {
      const jitter = (gi - 1) * 10
      const x = scenarioX(index) + jitter
      const value = panel.value(record)
      if (value === null) {
        const py = plotTop + 10
        parts.push(`<path d="M ${x - 4} ${py - 4} L ${x + 4} ${py + 4} M ${x + 4} ${py - 4} L ${x - 4} ${py + 4}" stroke="${group.color}" stroke-width="2"/>`)
        return
      }
      if (!Number.isFinite(value) || value < panel.min || value > panel.max) throw new Error('D metric outside plotted range')
      const py = yMap(value)
      parts.push(`<circle cx="${x}" cy="${py}" r="5.5" fill="${group.color}"/>`)
    }))
    groups[0].records.forEach((record, index) => {
      const x = scenarioX(index)
      parts.push(`<text class="small muted" text-anchor="middle" x="${x}" y="${plotBottom + 17}">${esc(labels(record)).replace('\n', ' / ')}</text>`)
    })
  })
  groups.forEach((group, index) => {
    const x = 165 + index * 300
    parts.push(`<circle cx="${x}" cy="750" r="5.5" fill="${group.color}"/><text class="small" x="${x + 12}" y="754">${esc(group.label)}</text>`)
  })
  parts.push('<text class="small muted" x="40" y="780">虚线：过冲30%、末窗误差0.10°；恢复须在±0.10°带内保持300ms；施扰时间1500ms，结束时间3000ms。</text>')
  return svgEnd(parts)
}

function makeMethodExplorationFigure() {
  const data = readJson(path.join(evidence, 'stage-d2-method-exploration.json'))
  if (data.agentGenerated || data.records.length !== 162) throw new Error('Unexpected D2 method exploration artifact')
  const main = data.records.filter(record => record.group === 'integral-and-window-sensitivity')
  const supplemental = data.records.filter(record => record.group !== 'integral-and-window-sensitivity')
  const controllers = ['baseline', 'conditional-integral', 'derivative-filter']
  const shortControllers = ['baseline', 'conditional I', 'D-filter 20ms']
  const kiValues = [0, 0.005, 0.01, 0.02]
  const durations = [3000, 4000]
  if (main.length !== 144 || supplemental.length !== 18) throw new Error('D2 method exploration group counts changed')
  const width = 1320
  const height = 690
  const parts = [svgStart(width, height, 'D2 local method exploration', 'Local simulation parameter and duration sensitivity exploration: 144 cases across six pressure conditions, plus 18 mechanism activation probes. Cells show convergence counts and integral suppression steps.')]
  parts.push('<text class="title" x="40" y="40">D2 方法探索 | 本机纯仿真 162 点</text>')
  parts.push('<text class="subtitle muted" x="40" y="65">上半部 144 点：Kp=6、Kd=16、固定冲量，多组Ki、时长、控制器和六类压力工况；单元格为收敛数/6。</text>')
  const gridX = 305
  const gridY = 135
  const colW = 158
  const rowH = 38
  for (let panel = 0; panel < durations.length; panel++) {
    const duration = durations[panel]
    const x = gridX + panel * 520
    parts.push(`<text class="panel-title" x="${x}" y="${gridY - 16}">${duration / 1000} 秒</text>`)
    controllers.forEach((controller, ci) => parts.push(`<text class="small muted" text-anchor="middle" x="${x + ci * colW + colW / 2}" y="${gridY + 3}">${shortControllers[ci]}</text>`))
    kiValues.forEach((ki, ri) => {
      const y = gridY + 18 + ri * rowH
      parts.push(`<text class="small" text-anchor="end" x="${x - 16}" y="${y + 17}">Ki=${ki}</text>`)
      controllers.forEach((controller, ci) => {
        const cell = main.filter(record => record.options.durationMs === duration && record.options.gains.AngleKi === ki && record.effectiveSim.controller.name === controller)
        if (cell.length !== 6) throw new Error(`Unexpected method grid ${duration}/${ki}/${controller}: ${cell.length}`)
        const converged = cell.filter(record => record.metrics.converged).length
        const fill = mixColor('#f1d3cf', '#d9eee6', converged / 6)
        const cellX = x + ci * colW
        parts.push(`<rect x="${cellX}" y="${y}" width="${colW - 8}" height="30" rx="2" fill="${fill}" stroke="${palette.grid}"/>`)
        parts.push(`<text class="small" text-anchor="middle" x="${cellX + (colW - 8) / 2}" y="${y + 20}">${converged}/6 收敛</text>`)
      })
    })
  }
  parts.push('<text class="small muted" x="40" y="330">在相同六类压力条件的组合中，Ki=0 全部收敛；Ki=0.02 在 3 秒与 4 秒均无收敛。延长窗口没有修复该候选。</text>')
  parts.push('<text class="panel-title" x="40" y="385">机制触发补充 | 18 点，无冲量；单元格为收敛状态 / 积分抑制步数</text>')
  const tableX = 300
  const tableY = 435
  const x0s = [3, 20, -20]
  const xLabels = ['x0=+3°', 'x0=+20°', 'x0=-20°']
  const kiSweep = [0.02, 0.05]
  const groupColW = 108
  xLabels.forEach((label, index) => {
    parts.push(`<text class="small muted" text-anchor="middle" x="${tableX + index * controllers.length * groupColW + controllers.length * groupColW / 2}" y="${tableY - 12}">${label}</text>`)
    controllers.forEach((controller, cIndex) => parts.push(`<text class="small muted" text-anchor="middle" x="${tableX + (index * controllers.length + cIndex) * groupColW + groupColW / 2}" y="${tableY + 7}">${shortControllers[cIndex]}</text>`))
  })
  kiSweep.forEach((ki, rowIndex) => {
    const y = tableY + 22 + rowIndex * 45
    parts.push(`<text class="small" text-anchor="end" x="${tableX - 15}" y="${y + 17}">Ki=${ki}</text>`)
    x0s.forEach((x0, xi) => controllers.forEach((controller, ci) => {
      const record = supplemental.find(item => item.options.gains.AngleKi === ki && item.options.x0 === x0 && item.effectiveSim.controller.name === controller)
      if (!record) throw new Error(`Missing supplemental method point ${ki}/${x0}/${controller}`)
      const cellX = tableX + (xi * controllers.length + ci) * groupColW
      const color = record.metrics.converged ? palette.good : palette.bad
      const suppressed = record.effectiveSim.controllerStats.integralSuppressedSteps
      parts.push(`<rect x="${cellX}" y="${y}" width="${groupColW - 8}" height="32" rx="2" fill="${record.metrics.converged ? '#d9eee6' : '#f1dddd'}" stroke="${palette.grid}"/>`)
      parts.push(`<text class="small" text-anchor="middle" x="${cellX + (groupColW - 8) / 2}" y="${y + 21}" fill="${color}">${record.metrics.converged ? 'pass' : 'fail'} / I=${suppressed}</text>`)
    }))
  })
  parts.push('<text class="small muted" x="40" y="620">Ki=0.02、x0=±20°时条件积分触发 11 步抑制且均收敛；baseline 未收敛。Ki=0.05 时三控制器均未收敛。</text>')
  parts.push('<text class="small muted" x="40" y="650">绿色：收敛；红色：未收敛；I 为积分抑制步数。上半部冲量施加于 1500ms；下半部为无冲量测试。</text>')
  return svgEnd(parts)
}

function makeM2MechanismFigure(data) {
  const parts = [svgStart(1420, 790, 'D2-M2 integral and saturation statistics', 'Four paired scenarios: control-loop integral peak, saturated steps, suppressed steps, settling time, IAE and command squared integral.')]
  parts.push('<text class="title" x="38" y="38">D2-M2 | 积分、饱和与恢复统计</text>')
  parts.push('<text class="subtitle muted" x="38" y="62">固定 gains 6 / 0.02 / 16；每条记录300个控制步（10ms）；积分峰值与步数取自控制环统计，IAE与输出平方积分取自50ms遥测。</text>')
  const panels = [
    { title: '积分峰值（°·控制步）', get: r => r.meta.sim.controllerStats.maxAbsIntegral, max: 450, ticks: [0,150,300,450] },
    { title: '输出饱和步数 / 300', get: r => r.meta.sim.controllerStats.saturatedSteps, max: 14, ticks: [0,4,8,12] },
    { title: '积分抑制步数 / 300', get: r => r.meta.sim.controllerStats.integralSuppressedSteps, max: 14, ticks: [0,4,8,12] },
    { title: '调节时间（ms）', get: r => r.metrics.settlingMs, max: 3000, ticks: [0,1000,2000,3000] },
    { title: 'IAE（°·s）', get: r => r.diagnostics.error.iaeDegSec, max: 10, ticks: [0,3,6,9] },
    { title: '输出平方积分（输出单位²·s）', get: r => r.diagnostics.output.energyOutputSquaredSec, max: 2800, ticks: [0,800,1600,2400] },
  ]
  panels.forEach((metric, i) => {
    const x = 35 + (i % 3) * 465
    const y = 92 + Math.floor(i / 3) * 302
    parts.push(`<text class="panel-title" x="${x + 58}" y="${y + 10}">${metric.title}</text>`)
    lineChart({ parts, x, y, w: 440, h: 282, values: data.pairs.map(p => ({ a: metric.get(p.a), b: metric.get(p.b) })), min: 0, max: metric.max, ticks: metric.ticks, colorA: palette.baseline, colorB: palette.conditional, formatter: v => String(v) })
  })
  parts.push(`<circle cx="55" cy="728" r="5" fill="${palette.baseline}"/><text class="small" x="67" y="732">Baseline</text>`)
  parts.push(`<rect x="160" y="723.5" width="9" height="9" fill="${palette.conditional}"/><text class="small" x="177" y="732">Conditional integral</text>`)
  parts.push('<text class="small muted" x="420" y="732">1 搜索(+20°, seed08)；2 验证(-20°, seed08)；3 验证(-20°, seed09)；4 验证(+20°, seed09)</text>')
  parts.push('<text class="small muted" x="38" y="765">积分为控制步内误差的离散累加；饱和步数统计 |out|=100；抑制步数统计条件积分暂停更新的控制步。</text>')
  return svgEnd(parts)
}

function pressureCase(r) {
  const s = r.meta.sim
  if (!s.disturbance) return `无冲量 / x0=${s.x0} / seed${String(s.seed).slice(-2)}`
  const p = s.simProfile
  if (!p) return `冲量${s.disturbance > 0 ? '+' : ''}${s.disturbance} / x0=${s.x0} / seed${String(s.seed).slice(-2)}`
  if (p.actuatorLagMs && p.deadZoneOutput && p.measurementDelayMs) return `组合 / x0=${s.x0} / seed${String(s.seed).slice(-2)}`
  if (p.deadZoneOutput) return '死区0.15'
  if (p.measurementDelayMs) return '测量延迟10ms'
  if (p.noise > .05) return '噪声0.15'
  if (p.controlScale < 1) return '控制/阻尼倍率0.85'
  return `执行器滞后${p.actuatorLagMs}ms`
}

function makeDiagnosticMatrix(title, definitions, withTail) {
  const groups = definitions.map(([id, label, color]) => {
    if (id === 'agnes-20261010-a') {
      const diagnostics = readJson(path.join(evidence,'stage-a-historical-diagnostics.json')).results
      const records = readIndex(path.join(evidence,id,'index.jsonl')).map(r => ({ ...r, diagnostics: diagnostics.find(d => d.runId === r.runId).diagnostics }))
      return { id, records, label, color }
    }
    return { ...campaign(id), label, color }
  })
  const metrics = [
    { title: '恢复时间（ms）', get: r => r.diagnostics.disturbance?.recoveryMs ?? null, max: 1500, digits: 0 },
    { title: '施扰后峰值（°）', get: r => r.diagnostics.disturbance?.observedPeakErrorDeg ?? null, max: 1.2, digits: 3 },
    ...(withTail ? [{ title: '末窗绝对误差（°）', get: r => Math.abs(r.metrics.ssErr), max: .15, digits: 4, threshold: .1 }] : []),
    { title: '整轮IAE（°·s）', get: r => r.diagnostics.error.iaeDegSec, max: 2.2, digits: 3 },
    { title: '整轮ISE（°²·s）', get: r => r.diagnostics.error.iseDeg2Sec, max: 4, digits: 3 },
    { title: '输出²积分（单位²·s）', get: r => r.diagnostics.output.energyOutputSquaredSec, max: 90, digits: 2 },
  ]
  const rowH = 31, gap = 106, x0 = 360, colW = 198
  const height = 135 + groups.reduce((n,g) => n + gap + rowH * g.records.filter(r => r.decision.purpose === 'robustness').length, 0) + 48
  const width = x0 + metrics.length * colW + 35
  const parts = [svgStart(width, height, title, 'Per-campaign robustness diagnostics: impulse recovery, post-impulse absolute error peak, IAE and command squared integral. Column scales are consistent across panels.')]
  parts.push(`<text class="title" x="38" y="38">${esc(title)}</text>`)
  parts.push('<text class="subtitle muted" x="38" y="62">逐条 robustness 验证；各列使用固定尺度。恢复要求：进入±0.10°并保持300ms；冲量施加于1500ms，结束时间3000ms。</text>')
  let top = 96
  groups.forEach(group => {
    const records = group.records.filter(r => r.decision.purpose === 'robustness')
    const g = records[0].gains
    if (records.some(r => JSON.stringify(r.gains) !== JSON.stringify(g))) throw new Error('Validation gains are not frozen')
    parts.push(`<text class="panel-title" x="38" y="${top + 18}">${esc(group.label)} | gains ${g.AngleKp}/${g.AngleKi}/${g.AngleKd}</text>`)
    metrics.forEach((m, mi) => {
      const x = x0 + mi * colW
      parts.push(`<text class="small" x="${x}" y="${top + 45}">${m.title}</text>`)
      const axisDigits = m.max < 1 ? 3 : Number.isInteger(m.max) ? 0 : 1
      for (const ratio of [0,.5,1]) parts.push(`<text class="small muted" text-anchor="middle" x="${x + ratio * 162}" y="${top + 66}">${(m.max * ratio).toFixed(axisDigits)}</text>`)
    })
    records.forEach((r, ri) => {
      const y = top + 85 + ri * rowH
      parts.push(`<text class="small" text-anchor="end" x="${x0 - 24}" y="${y + 4}">${ri + 1}. ${esc(pressureCase(r))}</text>`)
      metrics.forEach((m, mi) => {
        const x = x0 + mi * colW, value = m.get(r)
        parts.push(`<line x1="${x}" x2="${x + 162}" y1="${y}" y2="${y}" stroke="#edf0f3" stroke-width="11"/>`)
        if (value === null) { parts.push(`<text class="small muted" x="${x + 10}" y="${y + 4}">${r.diagnostics.disturbance ? '未恢复' : '无冲量'}</text>`); return }
        if (!Number.isFinite(value) || value < 0 || value > m.max) throw new Error(`Diagnostic matrix range: ${m.title}=${value}`)
        const px = x + value / m.max * 162
        const color = m.threshold && value > m.threshold ? palette.bad : group.color
        parts.push(`<line x1="${x}" x2="${px}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="7" opacity=".6"/>`)
        parts.push(`<circle cx="${px}" cy="${y}" r="3.5" fill="${color}"/>`)
        parts.push(`<text class="small" x="${x + 165}" y="${y + 4}" text-anchor="end">${value.toFixed(m.digits)}</text>`)
        if (m.threshold) { const tx = x + m.threshold / m.max * 162; parts.push(`<line x1="${tx}" x2="${tx}" y1="${y - 11}" y2="${y + 11}" stroke="${palette.bad}" stroke-dasharray="3 3"/>`) }
      })
    })
    top += gap + rowH * records.length
  })
  parts.push(`<text class="small muted" x="38" y="${height - 24}">${withTail ? '红点：末窗误差超过0.10°；虚线：对应门槛。' : '无冲量记录不计算施扰后的恢复与峰值。'}输出平方积分使用控制命令；各行编号仅对应所在批次的验证顺序。</text>`)
  return svgEnd(parts)
}

function makeStageTraceFigure(id, label) {
  const data = campaign(id), records = data.records.filter(r => r.decision.purpose === 'search')
  const colors = [palette.baseline, palette.filter, palette.conditional, palette.bad, '#8262a6', '#6b7c37']
  const rows = records.map(r => parseCsv(path.join(data.dir, r.csv)))
  const parts = [svgStart(1400, 910, `${label} search telemetry`, 'Complete search telemetry: angle, held command output, discrete integral and recorded J. Dashed vertical lines indicate impulse events.')]
  parts.push(`<text class="title" x="38" y="38">${label} | 全部搜索候选的遥测响应</text>`)
  parts.push('<text class="subtitle muted" x="38" y="62">角度、控制命令与积分为50ms采样；曲线颜色对应参数Kp/Ki/Kd。竖虚线标示冲量时刻，角度阴影为±0.10°。</text>')
  const panels = [{ title:'角度（°）', key:'angle' },{title:'控制命令（输出单位）',key:'out'}, {title:'积分（°·控制步）',key:'errInt'}, {title:'综合代价 J',key:null}]
  panels.forEach((p,pi) => {
    const x = 88 + (pi % 2) * 690, y = 137 + Math.floor(pi / 2) * 357, w = 604, h = 270
    parts.push(`<text class="panel-title" x="${x}" y="${y - 18}">${p.title}</text>`)
    let min = 0, max = .8
    if (p.key) { const vs=rows.flatMap(rs=>rs.map(r=>r[p.key])); min=Math.min(0,...vs);max=Math.max(0,...vs); const pad=Math.max(.05,(max-min)*.1);min-=pad;max+=pad }
    const mapY = v => y+h-(v-min)/(max-min)*h
    const mapX = v => x + v / (p.key ? 3000 : Math.max(1,records.length-1)) * w
    for(let i=0;i<=4;i++) { const v=min+(max-min)*i/4,py=mapY(v);parts.push(`<line class="grid" x1="${x}" x2="${x+w}" y1="${py}" y2="${py}"/><text class="small muted" text-anchor="end" x="${x-9}" y="${py+4}">${v.toFixed(2)}</text>`) }
    if (p.key === 'angle') parts.push(`<rect x="${x}" y="${mapY(.1)}" width="${w}" height="${mapY(-.1)-mapY(.1)}" fill="#d9eee6" opacity=".65"/>`)
    parts.push(`<line class="axis" x1="${x}" x2="${x}" y1="${y}" y2="${y+h}"/><line class="axis" x1="${x}" x2="${x+w}" y1="${y+h}" y2="${y+h}"/>`)
    if(p.key) {
      const impulse = records[0].meta.sim.disturbanceEvent?.atMs
      if(impulse != null) parts.push(`<line x1="${mapX(impulse)}" x2="${mapX(impulse)}" y1="${y}" y2="${y+h}" stroke="${palette.muted}" stroke-dasharray="6 5"/>`)
      rows.forEach((rs,i)=>parts.push(`<path d="${rs.map((r,k)=>k && p.key==='out' ? `H${mapX(r.ms).toFixed(2)} V${mapY(r[p.key]).toFixed(2)}` : `${k?'L':'M'}${mapX(r.ms).toFixed(2)},${mapY(r[p.key]).toFixed(2)}`).join(' ')}" fill="none" stroke="${colors[i]}" stroke-width="1.8"/>`))
      for(const t of [0,1000,2000,3000]) parts.push(`<text class="small muted" text-anchor="middle" x="${mapX(t)}" y="${y+h+20}">${t/1000}</text>`)
    } else {
      records.forEach((r,i)=>{ const px=mapX(i),py=mapY(r.metrics.j); if(r.metrics.converged) parts.push(`<circle cx="${px}" cy="${py}" r="5.5" fill="${colors[i]}"/>`); else parts.push(`<path d="M ${px-5} ${py-5} L ${px+5} ${py+5} M ${px+5} ${py-5} L ${px-5} ${py+5}" stroke="${colors[i]}" stroke-width="2"/>`); parts.push(`<text class="small muted" text-anchor="${i===records.length-1?'end':i===0?'start':'middle'}" x="${px}" y="${py-10}">${r.metrics.j.toFixed(4)}</text><text class="small muted" text-anchor="middle" x="${px}" y="${y+h+20}">${i+1}</text>`) })
    }
    parts.push(`<text class="small muted" text-anchor="middle" x="${x+w/2}" y="${y+h+42}">${p.key?'仿真时间（s）':'搜索评价顺序；圆：收敛，叉：未收敛'}</text>`)
  })
  records.forEach((r,i)=>{const x=80+i*213;parts.push(`<line x1="${x}" x2="${x+20}" y1="853" y2="853" stroke="${colors[i]}" stroke-width="2.5"/><text class="small" x="${x+27}" y="857">${r.gains.AngleKp}/${r.gains.AngleKi}/${r.gains.AngleKd}</text>`)})
  parts.push(`<text class="small muted" x="38" y="888">${data.records[0].meta.sim.modelVersion ?? 'legacy-1'}；search固定工况；积分按控制步累加；控制命令在相邻遥测点间按零阶保持解释。</text>`)
  return svgEnd(parts)
}

function main() {
  const audit = verifyFigureInputs()
  fs.mkdirSync(outDir, { recursive: true })
  const m2 = pairedM2()
  saveSvg('d2-m2-paired-metrics.svg', makeM2MetricsFigure(m2))
  saveSvg('d2-m2-response-traces.svg', makeResponseFigure(m2))
  saveSvg('d2-t-search-trajectories.svg', makeSearchFigure())
  saveSvg('grid-v23-ki0-heatmap.svg', makeGridFigure())
  saveSvg('selftest-v23-outcomes.svg', makeSelftestFigure())
  saveSvg('early-search-trajectories.svg', makeEarlySearchFigure())
  saveSvg('campaign-validation-scorecard.svg', makeValidationScorecard())
  saveSvg('stage-d-criterion-breakdown.svg', makeOriginalDFigure())
  saveSvg('d2-method-exploration.svg', makeMethodExplorationFigure())
  saveSvg('d2-m2-integral-saturation.svg', makeM2MechanismFigure(m2))
  saveSvg('abc-validation-diagnostics.svg', makeDiagnosticMatrix('先期与 A–C | 固定验证的扰动恢复与控制代价', [
    ['agnes-20261010-a','先期 v2.3 · legacy-1','#8262a6'],
    ['agnes-stage-a-20261010','Stage A · legacy-1',palette.baseline],
    ['agnes-stage-b-20261010','Stage B · sim-timing-2',palette.conditional],
    ['agnes-stage-c-20261010','Stage C · sim-pressure-3',palette.filter],
  ], false))
  saveSvg('d2-t-pressure-diagnostics.svg', makeDiagnosticMatrix('D2-T | 六类压力验证的连续指标', [
    ['agnes-stage-d2-t-baseline-20261010','Baseline',palette.baseline],
    ['agnes-stage-d2-t-conditional-integral-20261010','Conditional integral',palette.conditional],
    ['agnes-stage-d2-t-derivative-filter-20261010','Derivative filter 20ms',palette.filter],
  ], true))
  for (const [stage, label] of [['a','Stage A'],['b','Stage B'],['c','Stage C']]) {
    const id = `agnes-stage-${stage}-20261010`
    fs.writeFileSync(path.join(evidence,id,'search-traces.svg'),makeStageTraceFigure(id,label),'utf8')
  }
  fs.writeFileSync(path.join(outDir,'verification.json'),JSON.stringify(audit,null,2)+'\n')
  console.log(`Verified ${audit.recordsChecked} campaign records; generated 12 overview figures and 3 stage telemetry figures`)
}

main()
