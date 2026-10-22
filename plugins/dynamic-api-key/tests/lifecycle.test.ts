import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Schema } from 'effect';
import { ConfigPlugin } from '@opencode/schema/config/plugin';
import { ConfigProvider } from '@opencode/schema/config/provider';
import { parseConfig } from '../src/config.js';
import { KeyManager } from '../src/key-manager.js';
import { runCommand } from '../src/command.js';
import { config, deferred, safeError } from './helpers.js';

test('TTL with zero ahead expires at exact fractional boundary', async () => {
  let now = 0; let calls = 0;
  const m = new KeyManager(new Map([['a', config({ ttlSeconds: 0.2, refreshAheadSeconds: 0 })]]), { now: () => now, run: async () => `key-${++calls}` });
  try {
    const a = await m.ensureFresh('a'); now = 199.9;
    assert.equal(await m.ensureFresh('a'), a);
    now = 200; assert.equal(m.isCurrent('a', a), false);
    assert.equal((await m.ensureFresh('a')).key, 'key-2');
  } finally { await m.dispose(); }
});

test('pending provider does not block another provider; rejected concurrent refresh is single-flight', async () => {
  const gate = deferred<string>(); let callsA = 0; let callsB = 0;
  const ca = config(), cb = config();
  const m = new KeyManager(new Map([['a', ca], ['b', cb]]), { run: async c => {
    if (c === ca) { callsA++; return gate.promise; }
    callsB++; return 'key-b';
  } });
  try {
    const pending = Array.from({ length: 16 }, () => assert.rejects(m.ensureFresh('a'), safeError));
    assert.equal((await m.ensureFresh('b')).key, 'key-b');
    assert.equal(callsA, 1); assert.equal(callsB, 1);
    gate.reject(new Error('SECRET_MARKER')); await Promise.all(pending);
    assert.equal((await m.ensureFresh('b')).key, 'key-b');
  } finally { await m.dispose(); }
});

test('actual subprocess output rejection is secret-safe end to end', { timeout: 6000 }, async () => {
  for (const [format, code] of [
    ['text', 'process.stdout.write("")'],
    ['text', 'process.stdout.write("SECRET_MARKER bad key")'],
    ['text', 'process.stdout.write(Buffer.from([255]))'],
    ['json', 'process.stdout.write("SECRET_MARKER not-json")'],
    ['json', 'console.log(JSON.stringify({apiKey:"SECRET_MARKER", expiresAt:1}))'],
    ['json', 'console.log(JSON.stringify({apiKey:"SECRET_MARKER", expiresIn:0.001}))'],
  ]) {
    const m = new KeyManager(new Map([['a', config({ format, command: [process.execPath, '-e', code] })]]));
    try {
      await assert.rejects(m.ensureFresh('a'), (error: unknown) => {
        assert.ok(safeError(error));
        assert.doesNotMatch(String(error), /SECRET_MARKER|not-json|Unexpected|SyntaxError/); return true;
      });
    } finally { await m.dispose(); }
  }
});

test('runner removes abort listeners after success, failure, and cancellation; argv has no shell', async () => {
  const success = new AbortController();
  const literal = '$DYNAMIC_NEVER_EXPAND; printf injected';
  assert.equal(await runCommand(config({ command: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal] }), success.signal), literal);
  assert.equal(getEventListeners(success.signal, 'abort').length, 0);
  const failure = new AbortController();
  await assert.rejects(runCommand(config({ command: [process.execPath, '-e', 'process.exit(1)'] }), failure.signal), safeError);
  assert.equal(getEventListeners(failure.signal, 'abort').length, 0);
  const abort = new AbortController();
  const pending = runCommand(config({ command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] }), abort.signal);
  const rejected = assert.rejects(pending, safeError); abort.abort(); await rejected;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('real manager dispose terminates active command and remains disposed', { timeout: 6000 }, async () => {
  await mkdir(join(process.cwd(), '.artifacts'), { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.artifacts', 'manager-child-'));
  const pidfile = join(dir, 'pid'); let pid = 0;
  const m = new KeyManager(new Map([['a', config({ command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000)`] })]]));
  try {
    const pending = m.ensureFresh('a'); const rejected = assert.rejects(pending, safeError);
    for (let i = 0; i < 80; i++) {
      try { pid = Number(await readFile(pidfile, 'utf8')); if (pid) break; } catch { /* not spawned yet */ }
      await delay(20);
    }
    assert.ok(pid > 0, 'actual child was started');
    await m.dispose(); await rejected;
    assert.throws(() => process.kill(pid, 0));
    await assert.rejects(m.ensureFresh('a'), safeError);
  } finally {
    await m.dispose();
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* dead */ } }
    await rm(dir, { recursive: true, force: true });
  }
});

test('example JSON matches published OpenCode v2 provider/plugin schemas and own options', async () => {
  for (const filename of ['openai-http.json', 'openai-websocket.json', 'custom-provider.json']) {
    const data = JSON.parse(await readFile(new URL(`../examples/${filename}`, import.meta.url), 'utf8')) as { plugins: { options: unknown }[]; providers: Record<string, unknown> };
    Schema.decodeUnknownSync(ConfigPlugin.Plugins)(data.plugins);
    for (const provider of Object.values(data.providers)) Schema.decodeUnknownSync(ConfigProvider.Info)(provider);
    for (const entry of data.plugins) assert.ok(parseConfig(entry.options, process.cwd()).size > 0);
  }
});
