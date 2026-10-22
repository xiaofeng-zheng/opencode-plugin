import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runCommand, parseCommandOutput, OUTPUT_LIMIT } from '../src/command.js';
import { config, safeError } from './helpers.js';

const run = (code: string, extra: Record<string, unknown> = {}, signal = new AbortController().signal) =>
  runCommand(config({ command: [process.execPath, '-e', code], ...extra }), signal);

test('real argv command, cwd/env and stderr draining', async () => {
  assert.equal(await run('process.stderr.write("harmless diagnostic");process.stdout.write(process.env.DYNAMIC_TEST)', { env: { DYNAMIC_TEST: 'test-key' } }), 'test-key');
  assert.equal(await run('process.stdout.write(process.cwd())'), process.cwd());
  assert.equal(await runCommand(config({ command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write("shell-key")'` }), new AbortController().signal), 'shell-key');
});

test('real command failure and missing executable do not leak output or cause', async () => {
  for (const command of [[process.execPath, '-e', 'console.log("SECRET_MARKER");console.error("SECRET_MARKER");process.exit(19)'], ['/missing/SECRET_MARKER']]) {
    await assert.rejects(runCommand(config({ command }), new AbortController().signal), (error: unknown) => {
      assert.ok(safeError(error)); assert.doesNotMatch(String(error), /SECRET_MARKER|19|ENOENT/); return true;
    });
  }
});

test('real stdout and stderr are independently bounded at 64 KiB', async () => {
  assert.equal(OUTPUT_LIMIT, 65536);
  assert.equal((await run(`process.stdout.write('a'.repeat(${OUTPUT_LIMIT}))`)).length, OUTPUT_LIMIT);
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(run(`process.${stream}.write('SECRET_MARKER'.repeat(7000));setInterval(()=>{},1000)`), safeError);
  }
});

test('real timeout and cancellation terminate promptly and safely', { timeout: 6000 }, async () => {
  const started = performance.now();
  await assert.rejects(run('setInterval(()=>{},1000)', { timeoutSeconds: 0.1 }), safeError);
  assert.ok(performance.now() - started < 2000);
  const ac = new AbortController();
  const running = run('setInterval(()=>{},1000)', {}, ac.signal);
  setTimeout(() => ac.abort('SECRET_MARKER'), 75);
  await assert.rejects(running, (error: unknown) => safeError(error) && !String(error).includes('SECRET_MARKER'));
  const already = new AbortController(); already.abort();
  await assert.rejects(run('process.exit(0)', {}, already.signal), safeError);
});

test('POSIX abort kills a SIGTERM-resistant descendant process group', { skip: process.platform === 'win32', timeout: 8000 }, async () => {
  await mkdir(join(process.cwd(), '.artifacts'), { recursive: true });
  const dir = await mkdtemp(join(process.cwd(), '.artifacts', 'child-group-'));
  const pidfile = join(dir, 'pid');
  let pid = 0;
  try {
    const ac = new AbortController();
    const childCode = `require('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
    const result = run(parent, { timeoutSeconds: 4 }, ac.signal);
    const rejected = assert.rejects(result, safeError);
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidfile, 'utf8')); if (pid) break; } catch { /* wait for child */ }
      await delay(20);
    }
    assert.ok(pid > 0, 'descendant actually started');
    ac.abort(); await rejected;
    let live = true;
    for (let i = 0; i < 100 && live; i++) {
      try {
        process.kill(pid, 0);
        if (process.platform === 'linux') live = !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z ');
      } catch { live = false; }
      if (live) await delay(20);
    }
    assert.equal(live, false, 'descendant is dead (a Linux zombie is not running)');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ } }
    await rm(dir, { recursive: true, force: true });
  }
});

test('text output accepts one terminal LF/CRLF, never trims credential whitespace', () => {
  for (const text of ['test-key', 'test-key\n', 'test-key\r\n']) {
    assert.deepEqual(parseCommandOutput(text, config(), 1000, 1500), { key: 'test-key', expiresAt: 11000 });
  }
  for (const text of ['', ' ', '\n', ' key', 'key ', 'a b', 'a\tb', 'a\nb', 'key\n\n', 'key\x00', 'key\x7f', 'key\u0085']) {
    assert.throws(() => parseCommandOutput(text, config(), 1000, 1500), safeError);
  }
});

test('JSON expiry is relative to command start and capped by TTL', () => {
  const c = config({ format: 'json' });
  const parse = (v: unknown) => parseCommandOutput(JSON.stringify(v), c, 1000, 1500);
  assert.equal(parse({ apiKey: 'a' }).expiresAt, 11000);
  assert.equal(parse({ apiKey: 'a', expiresIn: 6.5 }).expiresAt, 7500);
  assert.equal(parse({ apiKey: 'a', expiresIn: 999 }).expiresAt, 11000);
  assert.equal(parse({ apiKey: 'a', expiresAt: 8 }).expiresAt, 8000);
  assert.equal(parse({ apiKey: 'a', expiresAt: '1970-01-01T00:00:08.000Z' }).expiresAt, 8000);
  assert.equal(parse({ apiKey: 'a', expiresAt: '2099-01-01T00:00:00Z' }).expiresAt, 11000);
  for (const v of [{}, [], { apiKey: '' }, { apiKey: 'a b' }, { apiKey: 'a', expiresIn: 0 }, { apiKey: 'a', expiresIn: -1 }, { apiKey: 'a', expiresAt: 1 }, { apiKey: 'a', expiresAt: 3.5 }, { apiKey: 'a', expiresAt: 'tomorrow' }, { apiKey: 'a', expiresAt: '2027-02-30T00:00:00Z' }, { apiKey: 'a', expiresAt: 10, expiresIn: 5 }, { apiKey: 'a', expiresIn: '5' }]) {
    assert.throws(() => parse(v), safeError);
  }
  assert.throws(() => parseCommandOutput('SECRET_MARKER invalid json', c, 1000, 1500), safeError);
  assert.throws(() => parseCommandOutput('a', config(), 1000, 9000), safeError);
});
