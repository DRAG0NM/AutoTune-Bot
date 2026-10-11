import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../evidence/versions');
export const historicalManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

/** Load only modules declared in the release manifest, after checking their byte hashes. */
export async function loadHistoricalVersion(version) {
  const entry = historicalManifest.versions[version];
  assert(entry, `Unknown historical version: ${version}`);
  const dir = path.join(root, version);
  for (const file of entry.files) {
    assert(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..'), 'Invalid historical module path');
    const sha = createHash('sha256').update(fs.readFileSync(path.join(dir, file.path))).digest('hex');
    assert.equal(sha, file.publishedSha256, `${version}/${file.path}: published module changed`);
  }
  const module = file => import(pathToFileURL(path.join(dir, file)).href);
  return { entry, simulator: await module('bridge/backends/sim.js'), metrics: await module('bridge/lib/metrics.js') };
}

export function versionForCampaign(id) {
  if (id === 'agnes-20261010-a') return 'v2.3';
  if (id.startsWith('agnes-stage-d2-')) return 'stage-d2';
  for (const stage of ['a', 'b', 'c', 'd']) if (id.startsWith(`agnes-stage-${stage}-`)) return `stage-${stage}`;
  throw new Error(`No historical model mapping: ${id}`);
}
