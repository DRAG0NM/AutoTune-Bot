import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('trial JSON and persisted index agree on decision eligibility', () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotune-cli-index-'));
  try {
    const result = spawnSync(process.execPath, [
      'bridge/cli.js', 'trial', '--backend', 'sim', '--dur', '1000',
      '--gains', 'AngleKp=4,AngleKi=0,AngleKd=8', '--json',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AUTOTUNE_RUNS_DIR: dir, AUTOTUNE_STATE_DIR: join(dir, 'state') },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const emitted = JSON.parse(result.stdout);
    const persisted = JSON.parse(readFileSync(join(dir, 'index.jsonl'), 'utf8').trim());
    assert.equal(typeof emitted.decisionEligible, 'boolean');
    assert.equal(persisted.decisionEligible, emitted.decisionEligible);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
