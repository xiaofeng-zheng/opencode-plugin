#!/usr/bin/env node
/** Test-only credential source. Never reads environment credentials. */
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const stateFile = process.argv[2];
if (!stateFile || !path.isAbsolute(stateFile)) {
  console.error('fixture requires an absolute test state path');
  process.exit(64);
}
const callID = randomUUID();
const logFile = `${stateFile}.calls.jsonl`;
const record = (event, extra = {}) => appendFile(logFile, `${JSON.stringify({
  event, callID, pid: process.pid, at: Date.now(), ...extra,
})}\n`, { mode: 0o600 });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await record('signal', { signal }).catch(() => {});
    process.exit(signal === 'SIGTERM' ? 143 : 130);
  });
}

try {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const mode = state.mode ?? 'text';
  const token = state.token ?? 'DUMMY_UNSET';
  if (!/^DUMMY_[A-Z0-9_]+$/.test(token)) throw new Error('not a dummy token');
  const delayMs = state.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 10_000) throw new Error('bad fixture delay');
  await record('start', { mode, token, delayMs });
  if (delayMs) await sleep(delayMs);
  if (mode === 'timeout') {
    // A safety ceiling even if the plugin fails to terminate this process.
    await sleep(60_000);
    await record('ceiling');
    process.exitCode = 124;
  } else if (mode === 'exit') {
    await record('exit', { code: 17 });
    console.error('DUMMY_FIXTURE_COMMAND_FAILED');
    process.exitCode = 17;
  } else {
    let output;
    if (mode === 'blank') output = ' \t\n';
    else if (mode === 'malformed') output = '{broken-json\n';
    else if (mode === 'multiline') output = `${token}\nDUMMY_SECOND_LINE\n`;
    else if (mode === 'json') {
      const expirySeconds = state.expirySeconds ?? 60;
      const expiry = state.expiryKind === 'unix'
        ? { expiresAt: Date.now() / 1000 + expirySeconds }
        : state.expiryKind === 'iso'
          ? { expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString() }
          : { expiresIn: expirySeconds };
      output = `${JSON.stringify({ apiKey: token, ...expiry })}\n`;
    } else if (mode === 'text') output = `${token}\n`;
    else throw new Error('unknown fixture mode');
    // Emission time bounds the lease age; the harness never guesses it from startup.
    await record('emitted', { mode, token });
    await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
  }
} catch {
  // Do not echo file contents, argv or arbitrary parse errors.
  await record('fixture-error').catch(() => {});
  console.error('DUMMY_FIXTURE_INVALID_STATE');
  process.exitCode = 65;
}
