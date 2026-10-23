#!/usr/bin/env node
/** Real installer + private OpenCode acceptance. All account/config data is synthetic. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { parse, modify, applyEdits } from 'jsonc-parser';

const root = resolve(import.meta.dirname, '..');
const binary = process.argv[2];
if (!binary || !binary.startsWith('/')) throw new Error('Usage: node scripts/installer-smoke.mjs /absolute/path/opencode');
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex');
const artifacts = join(root, '.artifacts', 'installer-smoke-' + stamp);
await mkdir(artifacts, { recursive: true });
const sandbox = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'opencode-installer-smoke-'));
const checkout = join(sandbox, 'checkout with spaces');
const home = join(sandbox, 'synthetic home');
const config = join(sandbox, 'config home', 'opencode');
const project = join(sandbox, 'unrelated working directory');
const report = { synthetic: true, sandbox, checkout, config, binary, checks: [], commands: [], serverExitCode: null };
const check = (name, evidence) => report.checks.push({ name, evidence });
const exists = async path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packagePath = slug => join(config, 'installed-plugins', slug, 'node_modules', `opencode-${slug}`);
const parsed = async path => parse(await readFile(path, 'utf8'));
const entry = (data, slug) => data.plugins.filter(item => item?.package === packagePath(slug));
let server;
let serverOut = '', serverError = '';
const password = randomBytes(32).toString('base64url');

async function baseline() {
  const current = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
  const hashes = {};
  for (const file of ['opencode.json', 'opencode.jsonc', 'cli.json']) {
    const path = join(current, file);
    hashes[path] = await exists(path) ? sha(await readFile(path)) : null;
  }
  return hashes;
}
const before = await baseline();

try {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  for (const file of files) {
    const source = join(root, file);
    if (!await exists(source)) continue;
    const metadata = await lstat(source);
    assert.ok(metadata.isFile(), `Only project-owned regular files may enter the clean checkout: ${file}`);
    await mkdir(dirname(join(checkout, file)), { recursive: true });
    await cp(source, join(checkout, file));
  }
  for (const path of [home, config, project, join(sandbox, 'tmp'), join(sandbox, 'data'), join(sandbox, 'cache'), join(sandbox, 'state')]) await mkdir(path, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'xterm-256color',
    OPENCODE_TEST_HOME: home, TMPDIR: join(sandbox, 'tmp'),
    XDG_CONFIG_HOME: dirname(config), XDG_DATA_HOME: join(sandbox, 'data'),
    XDG_CACHE_HOME: join(sandbox, 'cache'), XDG_STATE_HOME: join(sandbox, 'state'),
    OPENCODE_DB: join(sandbox, 'opencode.db'),
    OPENCODE_CONFIG_PROJECT_DISABLE: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_FILEWATCHER: 'true', OPENCODE_DISABLE_FFF: 'true',
    NODE_ENV: 'production', NPM_CONFIG_OMIT: 'dev',
    NPM_CONFIG_CACHE: join(sandbox, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(sandbox, 'empty-npmrc'),
  };
  await writeFile(env.NPM_CONFIG_USERCONFIG, '');
  const serverFile = join(config, 'opencode.jsonc');
  const clientFile = join(config, 'cli.json');
  const original = '{\n  // Synthetic user settings: preserve this comment.\n  "permissions": [{"action":"shell","resource":"*","effect":"ask"}],\n  "providers": {"openai":{"settings":{"transport":"http"}}},\n  "plugins": ["-installer-fixture.*"],\n}\n';
  await writeFile(serverFile, original);
  const optionsFile = join(sandbox, 'copilot options.json');
  await writeFile(optionsFile, JSON.stringify({ refreshSeconds: 0, cacheTtlSeconds: 60, timeoutSeconds: 5 }));
  const marker = join(sandbox, 'CREDENTIAL_COMMAND_MUST_NOT_RUN');
  const command = join(sandbox, 'credential-command.mjs');
  await writeFile(command, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'unexpected'); process.exit(91);\n`);
  const dynamicOptions = { providers: { 'installer-fixture': { command: [process.execPath, command], ttlSeconds: 60, refreshAheadSeconds: 5, allowedOrigins: ['https://example.invalid'] } } };
  const dynamicFile = join(sandbox, 'dynamic options.json');
  await writeFile(dynamicFile, JSON.stringify(dynamicOptions));

  async function installer(args, expected = 0) {
    const index = report.commands.length + 1;
    const child = spawn(join(checkout, 'install.sh'), [...args, '--opencode', binary], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 240000);
    let code, signal;
    try { [code, signal] = await once(child, 'exit'); }
    finally { clearTimeout(timer); }
    const log = join(artifacts, `install-${index}.log`);
    await writeFile(log, output);
    report.commands.push({ args, exitCode: code, signal, log });
    assert.equal(code, expected, `Installer failed; see ${log}`);
    assert.equal(await exists(marker), false, 'The installer must not execute credential commands.');
    return output;
  }

  assert.equal(await exists(join(checkout, 'node_modules')), false);
  await installer(['copilot-credits', '--options', optionsFile]);
  assert.equal(await exists(join(checkout, 'node_modules/jsonc-parser/package.json')), true);
  check('clean dependency bootstrap', 'A working-tree-only checkout with no node_modules installed its locked parser dependency.');
  const first = await parsed(serverFile);
  assert.deepEqual(first.providers, parse(original).providers);
  assert.deepEqual(first.permissions, parse(original).permissions);
  assert.equal(first.plugins[0], '-installer-fixture.*');
  assert.equal(entry(first, 'copilot-credits').length, 1);
  assert.equal(entry(await parsed(clientFile), 'copilot-credits').length, 1);
  assert.ok((await readFile(serverFile, 'utf8')).includes('// Synthetic user settings: preserve this comment.'));
  check('first Copilot installation', 'User-level server and CLI entries resolve to the installed package directory; unrelated settings and JSONC comments remain.');

  let clientText = await readFile(clientFile, 'utf8');
  clientText = applyEdits(clientText, modify(clientText, ['plugins', 0, 'options', 'refreshSeconds'], 120, {}));
  await writeFile(clientFile, clientText);
  const copilotRuntime = join(packagePath('copilot-credits'), 'dist/format.js');
  const expectedCopilot = sha(await readFile(copilotRuntime));
  await writeFile(copilotRuntime, '// Deliberately stale installed file for the update test.\n');
  const copilotConfig = await readFile(serverFile, 'utf8');
  await installer(['copilot-credits', '--config-dir', config]);
  assert.equal(sha(await readFile(copilotRuntime)), expectedCopilot);
  assert.equal(await readFile(serverFile, 'utf8'), copilotConfig);
  assert.equal(await readFile(clientFile, 'utf8'), clientText);
  check('Copilot update and idempotence', 'Same-version rerun repairs stale installed runtime bytes; server and client options stay distinct and config files stay byte-identical.');

  await installer(['dynamic-api-key'], 1);
  assert.equal(await readFile(serverFile, 'utf8'), copilotConfig);
  assert.equal(await exists(packagePath('dynamic-api-key')), false);
  check('missing dynamic options', 'Exit 1 before package promotion or config changes; no credential command executed.');
  await installer(['dynamic-api-key', '--options', dynamicFile]);
  const withBoth = await parsed(serverFile);
  assert.equal(entry(withBoth, 'dynamic-api-key').length, 1);
  assert.equal(entry(withBoth, 'copilot-credits').length, 1);
  assert.deepEqual(entry(withBoth, 'dynamic-api-key')[0].options, dynamicOptions);
  assert.equal(await readFile(clientFile, 'utf8'), clientText);
  check('first dynamic installation', 'Only the selected server plugin entry is added, preserving Copilot and client configuration.');

  const dynamicRuntime = join(packagePath('dynamic-api-key'), 'dist/index.js');
  const expectedDynamic = sha(await readFile(dynamicRuntime));
  await writeFile(dynamicRuntime, '// Deliberately stale installed file for the update test.\n');
  const bothText = await readFile(serverFile, 'utf8');
  await installer(['dynamic-api-key']);
  assert.equal(sha(await readFile(dynamicRuntime)), expectedDynamic);
  assert.equal(await readFile(serverFile, 'utf8'), bothText);
  assert.equal(entry(await parsed(serverFile), 'dynamic-api-key').length, 1);
  check('dynamic update and idempotence', 'Same-version rerun repairs runtime bytes without duplicating entries, changing options, or executing the credential command.');

  assert.equal(await exists(join(checkout, 'plugins/copilot-credits/node_modules/@babel/core/package.json')), true);
  assert.equal(await exists(join(checkout, 'plugins/dynamic-api-key/node_modules/typescript/package.json')), true);
  check('production-configured source builds', 'Both plugins build under NODE_ENV=production and NPM_CONFIG_OMIT=dev because source preparation explicitly includes development dependencies.');
  const backups = [];
  for (const name of (await readdir(config)).filter(name => name.includes('.bak-'))) {
    const directory = join(config, name);
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    for (const file of await readdir(directory)) backups.push(join(directory, file));
  }
  assert.ok(backups.length >= 2);
  for (const file of backups) assert.equal((await lstat(file)).mode & 0o777, 0o600);
  check('private config backups', { count: backups.length, fileMode: '0600', directoryMode: '0700' });

  assert.equal(await exists('/etc/opencode'), false, 'Review system config discovery before starting this isolated host.');
  server = spawn(binary, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: project, env: { ...env, OPENCODE_PASSWORD: password }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(server, 'exit');
  server.stdout.on('data', data => { serverOut += data; });
  server.stderr.on('data', data => { serverError += data; });
  const lines = createInterface({ input: server.stdout });
  const url = await new Promise((resolveURL, reject) => {
    const timer = setTimeout(() => reject(new Error('Private OpenCode server did not announce a URL.')), 45000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Private server exited before readiness.')); });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.url) { clearTimeout(timer); resolveURL(value.url); }
      } catch {}
    });
  });
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const query = new URLSearchParams({ 'location[directory]': project });
  const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  async function request(path, body) {
    const response = await fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45000),
    });
    assert.ok(response.ok, `Private host request failed: ${path}, HTTP ${response.status}`);
    return response.json();
  }
  report.serverInfo = await request('/api/info');
  // A location's plugin list can initially be empty while setup runs. The RPC
  // exercises the installed server implementation before inspecting its status.
  const rpc = await request('/api/rpc/copilot.credits/get?' + query, { input: { force: true } });
  assert.equal(rpc.output.status, 'disconnected');
  assert.equal(rpc.output.used, null);
  const expectedIDs = ['copilot.credits.server', 'dynamic-api-key'];
  const deadline = Date.now() + 15000;
  let plugins, list;
  do {
    plugins = await request('/api/plugin?' + query);
    list = plugins.data;
    assert.ok(Array.isArray(list), 'Unexpected plugin.list shape; inspect the saved real response.');
    if (expectedIDs.every(id => list.some(item => item.id === id))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  await writeFile(join(artifacts, 'loaded-plugins.json'), JSON.stringify(plugins, null, 2) + '\n');
  for (const id of expectedIDs) {
    const matches = list.filter(item => item.id === id);
    assert.equal(matches.length, 1, `Exactly one active ${id} is required.`);
    assert.equal(matches[0].state.status, 'active', `Plugin ${id} did not activate.`);
  }
  const unauthenticated = await fetch(url + '/api/rpc/copilot.credits/get?' + query, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"input":{}}', signal: AbortSignal.timeout(10000),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(await exists(marker), false);
  check('real user-level config loading', 'The private OpenCode server discovers both installed plugins from the installer-written XDG config, with no inline plugin overrides.');
  check('real isolated Copilot RPC', 'Authenticated request returns disconnected/null, unauthenticated request returns HTTP 401; no account or model request was made.');
  server.stdin.end();
  const killTimer = setTimeout(() => server.kill('SIGTERM'), 20000);
  try {
    const [code, signal] = await exited;
    report.serverExitCode = code;
    assert.equal(code, 0, `Private server did not exit cleanly (${signal}).`);
  } finally { clearTimeout(killTimer); }
  check('private server lifecycle', 'Stdio lease closed; private server exited with code 0.');
  assert.deepEqual(await baseline(), before);
  check('production config unchanged', before);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.stdin.end();
    const timer = setTimeout(() => server.kill('SIGTERM'), 15000);
    try { await once(server, 'exit'); }
    finally { clearTimeout(timer); }
    report.serverExitCode = server.exitCode;
  }
  await writeFile(join(artifacts, 'server-stdout.log'), serverOut.replaceAll(password, '[redacted-test-auth]'));
  await writeFile(join(artifacts, 'server-stderr.log'), serverError.replaceAll(password, '[redacted-test-auth]'));
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, report: join(artifacts, 'report.json'), sandbox }, null, 2));
}
