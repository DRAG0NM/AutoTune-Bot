import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('last-good state distinguishes defaults, legacy values, invalid data, and explicit verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autotune-last-good-'));
  const previous = process.env.AUTOTUNE_STATE_DIR;
  process.env.AUTOTUNE_STATE_DIR = dir;
  try {
    const store = await import(`../bridge/lib/store.js?test=${randomUUID()}`);
    const gains = { AngleKp: 4, AngleKi: 0, AngleKd: 8 };
    assert.equal(store.loadLastGoodState().status, 'unverified');

    mkdirSync(store.paths.state, { recursive: true });
    writeFileSync(join(store.paths.state, 'last_good.json'), JSON.stringify(gains));
    assert.equal(store.loadLastGoodState().status, 'unverified');
    assert.equal(store.loadLastGoodState().source, 'legacy-state-file');

    store.saveLastGood(gains);
    assert.equal(store.loadLastGoodState().status, 'unverified');
    store.saveLastGood(gains, { verified: true, verifiedAt: '2026-10-10T00:00:00.000Z' });
    assert.equal(store.loadLastGoodState().status, 'verified');
    assert.deepEqual(store.loadLastGoodState().gains, gains);
    assert.throws(() => store.saveLastGood(gains, { verified: true, verifiedAt: 'invalid' }), /verifiedAt/);

    writeFileSync(join(store.paths.state, 'last_good.json'), '{broken');
    assert.equal(store.loadLastGoodState().status, 'invalid');
    writeFileSync(join(store.paths.state, 'last_good.json'), JSON.stringify({ ...gains, AngleKp: 999 }));
    assert.equal(store.loadLastGoodState().status, 'invalid');
  } finally {
    if (previous === undefined) delete process.env.AUTOTUNE_STATE_DIR;
    else process.env.AUTOTUNE_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
