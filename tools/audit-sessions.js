#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessions = path.join(root, 'evidence/01_agh');
const read = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const specs = [
  ['agnes-20261010-a.jsonl', ['agnes-20261010-a']],
  ['agnes-stage-a-20261010.jsonl', ['agnes-stage-a-20261010']],
  ['agnes-stage-b-20261010.jsonl', ['agnes-stage-b-20261010']],
  ['agnes-stage-c-20261010.jsonl', ['agnes-stage-c-20261010']],
  ['agnes-stage-d-20261010.jsonl', ['baseline','conditional-integral','derivative-filter'].map(c => `agnes-stage-d-${c}-20261010-agent`), 658, 1225],
  ['d2-t-baseline.jsonl', ['agnes-stage-d2-t-baseline-20261010']],
  ['d2-t-conditional-integral.jsonl', ['agnes-stage-d2-t-conditional-integral-20261010']],
  ['d2-t-derivative-filter.jsonl', ['agnes-stage-d2-t-derivative-filter-20261010']],
  ['d2-m2-baseline.jsonl', ['agnes-stage-d2-m2-baseline-20261010']],
  ['d2-m2-conditional-integral.jsonl', ['agnes-stage-d2-m2-conditional-integral-20261010']],
];
const audits = specs.map(([file, campaigns, first = -Infinity, last = Infinity]) => {
  const events = read(path.join(sessions, file)).filter(e => e.seq >= first && e.seq <= last);
  const intents = events.filter(e => e.type === 'effect/intent');
  const settled = events.filter(e => e.type === 'effect/settled');
  const missing = intents.filter(i => !settled.some(s => s.data.effectId === i.data.effectId)).map(e => e.data.effectId);
  const unmatched = settled.filter(s => !intents.some(i => i.data.effectId === s.data.effectId)).map(e => e.data.effectId);
  const duplicates = list => list.filter((e,i) => list.slice(0,i).some(p => p.data.effectId === e.data.effectId)).map(e => e.data.effectId);
  const invalidDurations = settled.filter(e => e.data.durationMs !== undefined && (!Number.isInteger(e.data.durationMs) || e.data.durationMs < 0)).map(e => e.seq);
  const gaps = events.slice(1).filter((e,i) => e.seq !== events[i].seq + 1).map(e => e.seq);
  const calls = events.filter(e => e.type === 'tool/call');
  const results = events.filter(e => e.type === 'tool/result');
  const missingToolResults = calls.filter(c => !results.some(r => r.data.toolUseId === c.data.toolUseId)).map(e => e.data.toolUseId);
  const unmatchedToolResults = results.filter(r => !calls.some(c => c.data.toolUseId === r.data.toolUseId)).map(e => e.data.toolUseId);
  const duplicateToolIds = list => list.filter((e,i) => list.slice(0,i).some(p => p.data.toolUseId === e.data.toolUseId)).map(e => e.data.toolUseId);
  const invalidToolIds = [...calls,...results].filter(e => typeof e.data.toolUseId !== 'string' || !e.data.toolUseId || /\[REDACTED:/.test(e.data.toolUseId)).map(e => e.seq);
  const toolsBalanced = !missingToolResults.length && !unmatchedToolResults.length && !duplicateToolIds(calls).length && !duplicateToolIds(results).length && !invalidToolIds.length;
  const returns = events.filter(e => e.type === 'tool/result').map(e => JSON.stringify(e.data));
  const records = campaigns.flatMap(id => read(path.join(root, 'evidence/05_validation', id, 'index.jsonl')));
  const covered = records.filter(r => returns.some(s => s.includes(r.runId)));
  const completedTurns = events.filter(e => e.type === 'turn/end' && e.data.reason === 'completed').length;
  const prohibited = events.filter(e => e.type === 'tool/call' && e.data.name === 'shell' && /\bbridge\/cli\.js\s+(?:ports|set|start|stop|rollback)\b|--backend\s+serial\b/.test(JSON.stringify(e.data.args))).map(e => e.seq);
  const balanced = !missing.length && !unmatched.length && !duplicates(intents).length && !duplicates(settled).length && !invalidDurations.length;
  return { file, campaigns, events:events.length, firstSeq:events[0]?.seq, lastSeq:events.at(-1)?.seq,
    effectIntents:intents.length, effectSettled:settled.length, missingSettlements:missing, unmatchedSettlements:unmatched,
    duplicateIntents:duplicates(intents), duplicateSettlements:duplicates(settled), invalidDurations, sequenceGaps:gaps,
    toolCalls:calls.length, toolResults:results.length, missingToolResults, unmatchedToolResults,
    duplicateToolCalls:duplicateToolIds(calls), duplicateToolResults:duplicateToolIds(results), invalidToolIds,
    completedTurns, runCoverage:{covered:covered.length,total:records.length,missing:records.filter(r => !covered.includes(r)).map(r => r.runId)},
    prohibitedCallSeqs:prohibited, complete:balanced && toolsBalanced && !gaps.length && completedTurns > 0 && covered.length === records.length && !prohibited.length };
});
console.log(JSON.stringify({ allSessionsComplete:audits.every(a => a.complete), audits }, null, 2));
if (process.argv.includes('--strict') && audits.some(a => !a.complete)) process.exitCode = 1;
