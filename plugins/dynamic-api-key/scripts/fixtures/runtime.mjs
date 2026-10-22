import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function diagnostic(value) {
  return String(value?.stack ?? value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\bBasic\s+[A-Za-z0-9+/=_-]+/gi, 'Basic [REDACTED]')
    .replace(/\bBearer\s+(?!DUMMY_[A-Z0-9_]+\b)[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(-14_000);
}

export async function poll(check, { timeoutMs = 10_000, signal, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    const result = await check();
    if (result) return result;
    if (Date.now() >= end) throw new Error(`Deadline exceeded: ${label}`);
    await sleep(Math.min(40, Math.max(1, end - Date.now())), undefined, { signal });
  }
}

export async function writeState(file, state) {
  const staging = `${file}.${randomUUID()}.next`;
  await writeFile(staging, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(staging, file);
}

export async function calls(file) {
  let text;
  try { text = await readFile(`${file}.calls.jsonl`, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // appendFile is one small append per event. Ignore only the live final partial line.
  return text.split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
}
export async function invocationCount(file) { return (await calls(file)).filter((x) => x.event === 'start').length; }

export async function checkSystemConfig() {
  if (process.platform !== 'linux') throw new Error('This harness audits Linux isolation only; do not run against unchecked system/managed config roots.');
  try {
    const entries = await readdir('/etc/opencode');
    if (entries.length) throw new Error('Refusing to launch: /etc/opencode is nonempty; host system configuration must not be loaded.');
    return 'empty';
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

export async function sandbox(projectRoot) {
  const base = process.env.TMPDIR || path.join(projectRoot, '.integration');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(await realpath(base), 'dynamic-key-integration-'));
  await chmod(root, 0o700);
  const paths = Object.fromEntries(['home', 'config', 'xdg-config', 'data', 'cache', 'state', 'tmp', 'work'].map((name) => [name, path.join(root, name)]));
  await Promise.all(Object.values(paths).map((directory) => mkdir(directory, { recursive: true })));
  const modelFile = path.join(root, 'models.json');
  await writeFile(modelFile, '{}\n', { mode: 0o600 });
  // Deliberately NOT {...process.env}. No real keys, proxies, CLI config, service lease,
  // NODE_OPTIONS, npm auth, credentials or user paths are inherited.
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TZ: 'UTC', TERM: 'dumb', NO_COLOR: '1',
    HOME: paths.home, OPENCODE_TEST_HOME: paths.home, OPENCODE_CONFIG_DIR: paths.config,
    XDG_CONFIG_HOME: paths['xdg-config'], XDG_DATA_HOME: paths.data, XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state,
    OPENCODE_DB: path.join(paths.data, 'integration.db'), TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_MODELS_PATH: modelFile,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
    OPENCODE_DISABLE_FILEWATCHER: 'true', OPENCODE_FILEWATCHER_DISABLE: 'true', OPENCODE_DISABLE_FFF: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_TERMINAL_TITLE: 'true',
    OPENCODE_PASSWORD: `DUMMY_PRIVATE_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_cache: path.join(paths.cache, 'npm'), npm_config_userconfig: path.join(root, 'empty-npmrc'),
    npm_config_globalconfig: path.join(root, 'empty-npmrc'), BUN_INSTALL_CACHE_DIR: path.join(paths.cache, 'bun'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(paths.cache, 'transpiler'),
  };
  await writeFile(env.npm_config_userconfig, '', { mode: 0o600 });
  return { root, paths, env, async remove() { await rm(root, { recursive: true, force: true }); } };
}

export function spawnOwned(binary, args, box) {
  const child = spawn(binary, args, { cwd: box.paths.work, env: box.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, stdout: '', stderr: '', error: undefined, exit: undefined };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { record.stdout = (record.stdout + chunk).slice(-120_000); });
  child.stderr.on('data', (chunk) => { record.stderr = (record.stderr + chunk).slice(-120_000); });
  child.on('error', (error) => { record.error = error; });
  child.on('exit', (code, signal) => { record.exit = { code, signal }; });
  return record;
}

export async function stopOwned(record) {
  if (!record?.child.pid || record.exit) return;
  // The process group was created by this exact spawn; never discover/kill services.
  const kill = (signal) => {
    try { process.kill(-record.child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  kill('SIGTERM');
  try { await poll(() => record.exit, { timeoutMs: 3_000, label: 'owned server shutdown' }); }
  catch { kill('SIGKILL'); await poll(() => record.exit, { timeoutMs: 2_000, label: 'owned server force shutdown' }); }
}

export async function runVersion(binary, box, signal) {
  if (!path.isAbsolute(binary)) throw new Error('--binary must be an absolute executable path');
  await access(binary, constants.X_OK);
  const version = spawnOwned(binary, ['--version'], box);
  try {
    await poll(() => {
      if (version.error) throw version.error;
      return version.exit;
    }, { timeoutMs: 12_000, signal, label: 'binary --version' });
    if (version.exit.code !== 0) throw new Error(`--version failed: ${diagnostic(version.stderr)}`);
    const parsed = /\bv?(2\.\d+\.\d+(?:-[\w.-]+)?)\b/.exec(version.stdout);
    if (!parsed) throw new Error(`Not a recognized v2 binary: ${diagnostic(version.stdout)}`);
    return parsed[1];
  } finally { await stopOwned(version); }
}

export class PrivateAPI {
  constructor(url, env, signal, timeoutMs) {
    this.url = url; this.signal = signal; this.timeoutMs = timeoutMs;
    this.auth = `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString('base64')}`;
    this.operations = new Map();
  }
  async fetch(endpoint, { method = 'GET', body, timeoutMs = this.timeoutMs } = {}) {
    const url = new URL(endpoint, this.url);
    if (url.origin !== this.url || url.hostname !== '127.0.0.1') throw new Error('API client refused a non-private target');
    const signals = [AbortSignal.timeout(timeoutMs), ...(this.signal ? [this.signal] : [])];
    const response = await fetch(url, {
      method, headers: { authorization: this.auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any(signals), redirect: 'error',
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { throw new Error(`Non-JSON private API response: HTTP ${response.status} ${diagnostic(text)}`); }
    return { status: response.status, ok: response.ok, data };
  }
  async discover() {
    const response = await this.fetch('/openapi.json');
    if (!response.ok || !response.data?.paths) throw new Error(`Private OpenAPI failed: HTTP ${response.status}`);
    for (const [endpoint, methods] of Object.entries(response.data.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (operation.operationId) this.operations.set(operation.operationId, { endpoint, method: method.toUpperCase() });
      }
    }
    for (const name of ['server.info', 'session.create', 'session.generate', 'session.prompt', 'experimental.session.wait', 'session.context', 'session.get']) {
      if (!this.operations.has(name)) throw new Error(`Missing real OpenAPI operation: ${name}`);
    }
    return Object.fromEntries([...this.operations].filter(([name]) => ['server.info', 'session.create', 'session.generate', 'session.prompt', 'experimental.session.wait', 'session.context'].includes(name)));
  }
  async call(name, { params = {}, body, allowError = false, timeoutMs } = {}) {
    const operation = this.operations.get(name);
    if (!operation) throw new Error(`Unknown private API operation ${name}`);
    const endpoint = operation.endpoint.replace(/\{([^}]+)\}|:([A-Za-z][A-Za-z0-9_]*)/g, (_, bracket, colon) => {
      const key = bracket ?? colon;
      if (params[key] == null) throw new Error(`Missing API parameter ${key}`);
      return encodeURIComponent(params[key]);
    });
    const response = await this.fetch(endpoint, { method: operation.method, body, timeoutMs });
    if (!response.ok && !allowError) throw new Error(`${name}: HTTP ${response.status} ${diagnostic(JSON.stringify(response.data))}`);
    return response;
  }
}

export async function startPrivateServer(binary, box, signal, timeoutMs = 25_000) {
  const systemConfig = await checkSystemConfig();
  const child = spawnOwned(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], box);
  try {
    const url = await poll(() => {
      if (child.error) throw child.error;
      if (child.exit) throw new Error(`Private server exited ${JSON.stringify(child.exit)}: ${diagnostic(child.stderr + child.stdout)}`);
      return /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(child.stdout + child.stderr)?.[1];
    }, { timeoutMs: 40_000, signal, label: 'private server startup' });
    const api = new PrivateAPI(url, box.env, signal, timeoutMs);
    const operations = await api.discover();
    const info = (await api.call('server.info')).data;
    if (info.pid !== child.child.pid) throw new Error('server.info PID does not match the owned foreground child');
    // Verify the actual server paths, not just environment intent.
    const pathValues = (value) => typeof value === 'string' ? [value]
      : value && typeof value === 'object' ? Object.values(value).flatMap(pathValues) : [];
    const exposedPaths = pathValues(info.paths);
    for (const p of exposedPaths) if (path.isAbsolute(p) && p !== box.root && !p.startsWith(`${box.root}/`)) {
      throw new Error(`server.info exposed a path outside its isolated root: ${p}`);
    }
    return { child, api, info, operations, systemConfig };
  } catch (error) { await stopOwned(child); throw error; }
}

export async function stopFixtureCommands(stateFiles) {
  const owned = new Map();
  for (const file of stateFiles) for (const call of await calls(file)) {
    if (call.event === 'start') owned.set(call.pid, file);
  }
  const stopped = [];
  for (const [pid, file] of owned) {
    // Guard PID reuse with the exact unique state argv; never touch an unrelated PID.
    let argv;
    try { argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    if (!argv.includes(file) || !argv.some((x) => x.endsWith('/fixtures/key-command.mjs'))) continue;
    try {
      process.kill(pid, 'SIGKILL');
      await poll(async () => {
        try { return !(await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').includes(file); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error; }
      }, { timeoutMs: 2000, label: 'owned credential fixture shutdown' });
      stopped.push(pid);
    }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return stopped;
}
