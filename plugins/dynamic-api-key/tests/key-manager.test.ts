import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyManager } from '../src/key-manager.js';
import { config, deferred, safeError } from './helpers.js';

test('lazy mint, TTL/ahead exact boundary, independent provider state and single-flight', async () => {
  let now = 1000; let calls = 0;
  const gate = deferred<string>();
  const c = config();
  const manager = new KeyManager(new Map([['a', c], ['b', c]]), {
    now: () => now,
    run: async () => { calls++; return calls === 1 ? gate.promise : `key-${calls}`; },
  });
  assert.equal(calls, 0);
  const pending = Array.from({ length: 20 }, () => manager.ensureFresh('a'));
  await Promise.resolve(); assert.equal(calls, 1);
  gate.resolve('key-1');
  const leases = await Promise.all(pending);
  assert.ok(leases.every(x => x === leases[0]));
  const first = leases[0]!;
  now = 8999; assert.equal(await manager.ensureFresh('a'), first);
  now = 9000;
  const next = await Promise.all(Array.from({ length: 30 }, () => manager.ensureFresh('a')));
  assert.equal(calls, 2); assert.equal(next[0]!.generation, 2);
  assert.equal(await manager.ensureFresh('a'), next[0]);
  assert.equal((await manager.ensureFresh('b')).key, 'key-3');
  assert.equal(calls, 3); await manager.dispose();
});

test('failed refresh clears still-live lease and recovers without fallback', async () => {
  let now = 1000; let calls = 0;
  const manager = new KeyManager(new Map([['a', config()]]), {
    now: () => now,
    run: async () => { calls++; if (calls === 2) throw new Error('SECRET_MARKER'); return `key-${calls}`; },
  });
  const old = await manager.ensureFresh('a');
  now = 9000;
  await assert.rejects(manager.ensureFresh('a'), (e: unknown) => safeError(e) && !String(e).includes('SECRET_MARKER'));
  assert.equal(manager.isCurrent('a', old), false);
  const recovered = await manager.ensureFresh('a');
  assert.equal(recovered.key, 'key-3'); assert.notEqual(recovered.generation, old.generation);
  await manager.dispose();
});

test('401 invalidates exactly the used generation/key; late 401 cannot erase rotation', async () => {
  let now = 0; let calls = 0;
  const manager = new KeyManager(new Map([['a', config()]]), { now: () => now, run: async () => `key-${++calls}` });
  const a = await manager.ensureFresh('a');
  now = 8000; const b = await manager.ensureFresh('a');
  manager.invalidate('a', a); assert.equal(manager.isCurrent('a', b), true);
  manager.invalidate('a', { ...b, key: 'wrong-key' }); assert.equal(manager.isCurrent('a', b), true);
  manager.invalidate('a', b); assert.equal(manager.isCurrent('a', b), false);
  assert.equal((await manager.ensureFresh('a')).key, 'key-3'); await manager.dispose();
});

test('refresh duration counts against TTL and rejects an ahead-window result', async () => {
  let now = 0;
  const manager = new KeyManager(new Map([['a', config()]]), { now: () => now, run: async () => { now = 8000; return 'key'; } });
  await assert.rejects(manager.ensureFresh('a'), safeError); await manager.dispose();
});

test('dispose aborts refresh, clears leases, and cannot be undone by late completion', async () => {
  const gate = deferred<string>(); let signal: AbortSignal | undefined;
  const manager = new KeyManager(new Map([['a', config()]]), { now: () => 0, run: async (_c, s) => { signal = s; return gate.promise; } });
  const pending = manager.ensureFresh('a');
  const rejected = assert.rejects(pending, safeError);
  await Promise.resolve();
  const disposal = manager.dispose(); assert.equal(signal!.aborted, true);
  gate.resolve('late-secret'); await rejected; await disposal;
  await assert.rejects(manager.ensureFresh('a'), safeError);
  assert.equal(manager.isCurrent('a', { key: 'late-secret', generation: 1, expiresAt: 10000 }), false);
  await manager.dispose();
});

test('a failed provider does not poison another and JSON expiry affects manager', async () => {
  let now = 1000; let calls = 0;
  const good = config({ format: 'json' }); const bad = config();
  const manager = new KeyManager(new Map([['a', good], ['b', bad]]), { now: () => now, run: async c => { calls++; if (c === bad) return ''; return '{"apiKey":"same","expiresIn":5}'; } });
  const a = await manager.ensureFresh('a');
  await assert.rejects(manager.ensureFresh('b'), safeError);
  assert.equal(manager.isCurrent('a', a), true);
  now = 4000; assert.equal(manager.isCurrent('a', a), false);
  const b = await manager.ensureFresh('a'); assert.equal(b.key, a.key); assert.notEqual(b.generation, a.generation);
  assert.equal(calls, 3); await manager.dispose();
});
