#!/usr/bin/env node
/**
 * Isolated real OpenCode v2 integration matrix (Node >= 22, no ws dependency).
 *   node scripts/integration.mjs --self-test
 *   node scripts/integration.mjs --binary /absolute/opencode --runtime-probe
 *   node scripts/integration.mjs --binary /absolute/old --binary /absolute/new --output .artifacts/integration.json
 * Build dist/index.js and install its LOCAL dependencies before the last command.
 * Never invokes `service`, reads user config, installs packages, or selects a real model.
 */
import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { ASSISTANT_TEXT, createMockOpenAI } from './fixtures/mock-openai.mjs';
import {
  calls, checkSystemConfig, diagnostic, invocationCount, poll, sandbox,
  runVersion, startPrivateServer, stopOwned, stopFixtureCommands, writeState,
} from './fixtures/runtime.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptRoot);
const commandFixture = path.join(scriptRoot, 'fixtures/key-command.mjs');
const HTTP = 'rotating-test';
const WS = 'rotating-ws';
const GUARD = 'rotating-ws-guard';

async function fingerprint(target) {
  const isPackage = (await stat(target)).isDirectory();
  const directory = isPackage ? target : path.dirname(target);
  const runtimeDirectory = isPackage ? path.join(target, 'dist') : directory;
  const entries = await readdir(runtimeDirectory, { withFileTypes: true });
  const files = new Set([
    ...(isPackage ? ['package.json', 'server.js'] : [path.basename(target)]),
    ...entries.filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name))
      .map((entry) => isPackage ? path.join('dist', entry.name) : entry.name),
  ]);
  return Object.fromEntries(await Promise.all([...files].sort().map(async (name) => [name,
    createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')])));
}

function options(argv) {
  const out = { binaries: [], plugin: projectRoot, ttlSeconds: 4, deadlineSeconds: 180, requestTimeoutSeconds: 25 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--self-test', '--runtime-probe', '--http-only', '--keep-temp', '--help'].includes(key)) {
      out[key.slice(2)] = true; continue;
    }
    if (!['--binary', '--output', '--plugin', '--ttl-seconds', '--deadline-seconds', '--request-timeout-seconds'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (key === '--binary') {
      if (!path.isAbsolute(value)) throw new Error('--binary must be an absolute path');
      out.binaries.push(value);
    } else if (key === '--plugin') out.plugin = path.resolve(value);
    else if (key === '--output') out.output = path.resolve(value);
    else {
      const prop = { '--ttl-seconds': 'ttlSeconds', '--deadline-seconds': 'deadlineSeconds', '--request-timeout-seconds': 'requestTimeoutSeconds' }[key];
      out[prop] = Number(value);
      if (!Number.isFinite(out[prop]) || out[prop] <= 0) throw new Error(`Invalid number for ${key}`);
    }
  }
  if (out.ttlSeconds < 2) throw new Error('--ttl-seconds must be >= 2 for the cache/reuse timing assertions (WS guard separately uses a fractional TTL).');
  if (out['self-test'] && out['runtime-probe']) throw new Error('Choose --self-test or --runtime-probe');
  if (!out.help && !out['self-test'] && !out.binaries.length) throw new Error('Supply --binary /absolute/opencode (repeat for a version matrix), or --self-test');
  return out;
}

function help() {
  console.log(`Usage: node scripts/integration.mjs --binary /absolute/opencode [options]
  --binary PATH                Repeat to compare real server versions, sequentially
  --output FILE                Write machine-readable evidence (default: JSON stdout)
  --plugin PATH                Plugin package directory (default: project root); JS file is debug-wrapper mode
  --ttl-seconds N              HTTP/WS cache TTL (default 4; minimum 2)
  --deadline-seconds N         Overall deadline per private server (default 180)
  --request-timeout-seconds N  Per real API request deadline (default 25)
  --http-only                  Explicit partial coverage, not a full WS acceptance
  --runtime-probe              Real native HTTP/WS fixture smoke; NO plugin acceptance
  --self-test                  Command and RFC6455/HTTP fixtures only; no OpenCode needed
  --keep-temp                  Keep isolated dummy-only files for diagnosis

Needs Linux, Node >=22, a local OpenCode v2 executable. Full matrix additionally
needs the built local plugin and its already-installed dependencies. No npm install
or ws package is used. Temporary roots live under TMPDIR (or .integration).
Nonempty /etc/opencode is a hard refusal. Child environments are explicit allowlists.
HTTP uses session.generate. WS uses session.prompt + experimental.session.wait +
session.context; session.generate is stateless HTTP even with transport=websocket.
Every WS acceptance checks actual Upgrade auth and outbound response.create frames;
HTTP fallback for WS providers is deliberately rejected by the upstream fixture.
Exit 0 means ONLY the selected mode/cases passed; consult coverage.mode in the JSON.`);
}

async function setupConfig(box, mock, opts) {
  const full = !opts['runtime-probe'];
  let pluginDirectory;
  if (full) {
    if ((await stat(opts.plugin)).isDirectory()) {
      // Exercise the package EXACTLY as documented: no synthesized wrapper.
      pluginDirectory = opts.plugin;
    } else {
      // Explicit JS-file mode is only a debugging aid, not package acceptance.
      pluginDirectory = path.join(box.root, 'plugin-package');
      await mkdir(pluginDirectory);
      await writeFile(path.join(pluginDirectory, 'package.json'), '{"name":"dynamic-key-integration-loader","type":"module","private":true}\n', { mode: 0o600 });
      await writeFile(path.join(pluginDirectory, 'server.js'), `export { default } from ${JSON.stringify(pathToFileURL(opts.plugin).href)};\n`, { mode: 0o600 });
    }
  }
  const definitions = {
    [HTTP]: { token: 'DUMMY_A', mode: 'text' },
    [WS]: { token: 'DUMMY_WS_A', mode: 'text' },
    [GUARD]: { token: 'DUMMY_GUARD_A', mode: 'text' },
    'rotating-native': { token: 'DUMMY_NATIVE_FRESH', mode: 'text' },
    'rotating-header': { token: 'DUMMY_CUSTOM_HEADER', mode: 'text' },
    'rotating-json': { token: 'DUMMY_JSON_A', mode: 'json', expirySeconds: 1.5 },
    'rotating-unix': { token: 'DUMMY_UNIX_EXPIRED', mode: 'json', expirySeconds: -1, expiryKind: 'unix' },
    'rotating-iso': { token: 'DUMMY_ISO_EXPIRED', mode: 'json', expirySeconds: -1, expiryKind: 'iso' },
    'rotating-denied': { token: 'DUMMY_MUST_NOT_MINT', mode: 'text' },
  };
  const providers = {}; const dynamic = {}; const stateFiles = {};
  for (const [id, state] of Object.entries(definitions)) {
    if (!full && ![HTTP, WS].includes(id)) continue;
    const isWS = [WS, GUARD].includes(id);
    const stateFile = path.join(box.root, `${id}.state.json`);
    await writeState(stateFile, state); stateFiles[id] = stateFile;
    providers[id] = {
      package: `@opencode/ai/providers/openai/${isWS ? 'responses' : 'chat'}`,
      settings: { baseURL: `${mock.url}/v1`, transport: isWS ? 'websocket' : 'http',
        ...(!full ? { apiKey: isWS ? 'DUMMY_FIXTURE_WS' : 'DUMMY_FIXTURE_HTTP' }
          : id === 'rotating-native' ? { apiKey: 'DUMMY_NATIVE_STALE' } : {}) },
      headers: { 'x-integration-provider': id,
        ...(full && id === HTTP ? { authorization: 'Bearer DUMMY_CONFIG_STALE' } : {}) },
      models: { probe: {} },
    };
    dynamic[id] = {
      command: [process.execPath, commandFixture, stateFile],
      ttlSeconds: id === GUARD ? 1.25 : opts.ttlSeconds,
      refreshAheadSeconds: 0, timeoutSeconds: 1.5,
      allowedOrigins: [id === 'rotating-denied' ? 'http://127.0.0.1:1' : mock.url],
      format: state.mode === 'json' ? 'json' : 'text',
      ...(id === 'rotating-header' ? { header: 'x-api-key', prefix: 'Token ' } : {}),
    };
  }
  const config = {
    update: 'disable', share: 'disabled', snapshots: false, warming: false,
    model: { providerID: HTTP, model: 'probe' }, default_agent: 'integration-probe',
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    agents: {
      'integration-probe': { mode: 'primary', system: 'This is an offline protocol test. Reply briefly; do not call tools.', steps: 2 },
      title: { disabled: true }, compaction: { disabled: true },
    },
    providers, plugins: full ? [{ package: pluginDirectory, options: { providers: dynamic } }] : [],
  };
  await writeFile(path.join(box.paths.config, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { stateFiles, dynamic, pluginDirectory };
}

async function runBinary(binary, opts) {
  const startedAt = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Overall private integration deadline exceeded')), opts.deadlineSeconds * 1000);
  let interrupted = false;
  const interrupt = () => { interrupted = true; abort.abort(new Error('Integration interrupted')); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const report = {
    binary, mode: opts['runtime-probe'] ? 'runtime-fixture-probe' : opts['http-only'] ? 'plugin-http-only' : 'plugin-http-and-websocket',
    startedAt: new Date(startedAt).toISOString(), status: 'running', tests: [], sessionIDs: [],
    clientVersion: null, serverVersion: null, pidBefore: null, pidAfter: null,
    coverage: {
      pluginAcceptance: !opts['runtime-probe'], websocketSelected: !opts['http-only'],
      httpAPI: 'session.generate', websocketAPI: 'session.prompt + experimental.session.wait + session.context',
      excluded: ['global generate.text bypasses Session hooks', 'session.generate cannot prove durable WebSocket use',
        'primary/title/compaction retry permutations beyond the cases listed', 'non-native SDKs and real external providers'],
    },
    isolation: { inheritedEnvironment: 'explicit allowlist; no process.env spread', networkSandbox: false,
      note: 'Only explicit fake providers, loopback endpoints and a local empty model catalogue are used; this is not an OS egress sandbox.',
      npmInstallInvokedByHarness: false, sharedServiceTouched: false },
  };
  let box, mock, server, stateFiles = {}, dynamic = {};
  const capture = async () => ({
    commands: Object.fromEntries(await Promise.all(Object.entries(stateFiles).map(async ([id, file]) => [id, await invocationCount(file)]))),
    upstream: mock?.counts() ?? null,
  });
  async function test(name, fn) {
    const begin = Date.now();
    const entry = { name, status: 'running', before: await capture() };
    report.tests.push(entry);
    try { entry.evidence = await fn(); entry.status = 'pass'; }
    catch (error) { entry.status = 'fail'; entry.error = diagnostic(error); }
    entry.after = await capture(); entry.runtimeSeconds = (Date.now() - begin) / 1000;
    process.stderr.write(`[${report.clientVersion ?? 'preflight'}] ${entry.status.toUpperCase()} ${name}\n`);
    return entry.status === 'pass';
  }
  async function group(cases) {
    let previous = true;
    for (const [name, fn] of cases) {
      if (previous) previous = await test(name, fn);
      else report.tests.push({ name, status: 'skip', reason: 'An earlier prerequisite in this group failed; not executed.' });
    }
  }
  const commandCount = (id) => invocationCount(stateFiles[id]);
  const set = (id, token, extra = {}) => writeState(stateFiles[id], { token, mode: 'text', ...extra });
  async function expire(id, seconds = dynamic[id].ttlSeconds) {
    const latest = (await calls(stateFiles[id])).filter((x) => x.event === 'emitted').at(-1);
    assert.ok(latest, `No completed mint for ${id}`);
    const deadline = latest.at + seconds * 1000 + 300;
    await poll(() => Date.now() >= deadline, { timeoutMs: seconds * 1000 + 1500, signal: abort.signal, label: `${id} lease expiry` });
    return { emittedAt: latest.at, waitedUntil: Date.now(), effectiveTTLSeconds: seconds };
  }
  async function session(provider = HTTP) {
    const response = await server.api.call('session.create', { body: {
      title: `Dynamic key isolated ${provider}`, agent: 'integration-probe',
      location: { directory: box.paths.work }, model: { providerID: provider, id: 'probe' },
    } });
    const info = response.data?.data;
    assert.ok(typeof info?.id === 'string' && info.id.length, 'session.create did not return data.id');
    report.sessionIDs.push({ id: info.id, providerID: provider });
    // Verify the actual selection rather than accepting a default/catalog fallback.
    assert.equal(info.model?.providerID, provider, 'Session selected an unexpected provider');
    assert.equal(info.model?.id, 'probe', 'Session selected an unexpected model');
    return info.id;
  }
  async function generate(id, { failure = false } = {}) {
    const response = await server.api.call('session.generate', { params: { sessionID: id }, body: { prompt: 'ping' }, allowError: failure });
    if (failure) {
      assert.ok(!response.ok && response.status >= 400, 'Expected a real API failure, not a successful generation');
      return { status: response.status, error: diagnostic(JSON.stringify(response.data)) };
    }
    assert.equal(response.data?.data?.text, ASSISTANT_TEXT, 'Expected the assistant output, not a prompt echo');
    return { status: response.status, text: response.data.data.text };
  }
  async function prompt(id, { failure = false } = {}) {
    const params = { sessionID: id };
    const previous = (await server.api.call('session.context', { params })).data.data;
    assert.ok(Array.isArray(previous), 'session.context data must be an array');
    const ids = new Set(previous.map((message) => message.id));
    const admitted = await server.api.call('session.prompt', { params, body: { text: 'ping', resume: true } });
    const waited = await server.api.call('experimental.session.wait', { params, allowError: true });
    const context = (await server.api.call('session.context', { params })).data.data;
    const current = context.filter((message) => !ids.has(message.id));
    const assistant = current.filter((message) => message.type === 'assistant');
    const texts = assistant.map((message) => (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join(''));
    const info = (await server.api.call('session.get', { params })).data.data;
    if (!failure) {
      assert.equal(waited.ok, true, 'The durable runner did not reach a successful wait response');
      assert.ok(texts.includes(ASSISTANT_TEXT), `No NEW assistant ${ASSISTANT_TEXT}; context types: ${current.map((x) => x.type).join(',')}`);
    } else {
      assert.ok(!texts.includes(ASSISTANT_TEXT), 'A blocked WS generation unexpectedly produced an assistant success');
      assert.ok(waited.ok || waited.status >= 400, 'Runner did not complete a real API response');
    }
    return { promptStatus: admitted.status, waitStatus: waited.status, texts,
      newMessageTypes: current.map((x) => x.type), assistantIDs: assistant.map((x) => x.id),
      state: info.status ?? info.state ?? null, error: info.error ? diagnostic(JSON.stringify(info.error)) : null };
  }
  const received = (id) => mock.requests.filter((x) => x.provider === id);
  const sockets = (id) => mock.upgrades.filter((x) => x.provider === id);
  const checkAuth = (id, expected) => assert.equal(received(id).at(-1)?.authorization, `Bearer ${expected}`);
  const checkWS = (id, before, { upgrades = 1, frames = 1, token } = {}) => {
    const after = mock.counts(id);
    assert.equal(after.http, before.http, 'WS generated an HTTP request: fallback is not WS acceptance');
    assert.equal(after.upgrades - before.upgrades, upgrades, 'Unexpected WS Upgrade count');
    assert.equal(after.frames - before.frames, frames, 'Unexpected actual outbound WS frame count');
    if (token) assert.equal(sockets(id).at(-1)?.authorization, `Bearer ${token}`);
    return after;
  };

  try {
    // Do not wait for another worker or build/install anything on the user's behalf.
    await checkSystemConfig();
    if (!opts['runtime-probe']) await access(opts.plugin).catch(() => { throw new Error(`Plugin package or built entry missing: ${opts.plugin}. Build it separately, or use --runtime-probe/--self-test (neither proves plugin acceptance).`); });
    if (!opts['runtime-probe']) report.artifactSha256 = await fingerprint(opts.plugin);
    box = await sandbox(projectRoot);
    report.isolation.root = box.root;
    report.isolation.environmentKeys = Object.keys(box.env).sort();
    report.clientVersion = await runVersion(binary, box, abort.signal);
    report.binaryResolved = await realpath(binary);
    mock = await createMockOpenAI();
    const configured = await setupConfig(box, mock, opts);
    ({ stateFiles, dynamic } = configured);
    report.pluginPackaging = opts['runtime-probe'] ? null : {
      target: opts.plugin, configuredDirectory: configured.pluginDirectory,
      mode: configured.pluginDirectory === opts.plugin ? 'direct-package-directory' : 'debug-file-wrapper',
      note: configured.pluginDirectory === opts.plugin
        ? 'The real package directory is configured directly, with its shipped server.js; no synthesized wrapper.'
        : 'Explicit file debug mode uses a private wrapper; this does not prove package installation.',
    };
    server = await startPrivateServer(binary, box, abort.signal, opts.requestTimeoutSeconds * 1000);
    report.serverVersion = server.info.version; report.pidBefore = server.info.pid;
    report.isolation.systemConfig = server.systemConfig;
    report.isolation.actualServerPaths = server.info.paths;
    report.privateURL = server.api.url; report.mockURL = mock.url; report.operations = server.operations;
    assert.equal(report.serverVersion, report.clientVersion, 'Client/server version mismatch');
    report.options = { ttlSeconds: opts.ttlSeconds, commandTimeoutSeconds: 1.5, plugin: opts['runtime-probe'] ? null : opts.plugin };

    if (opts['runtime-probe']) {
      await test('http.native_fixture_smoke', async () => {
        const id = await session(); const before = mock.counts(HTTP);
        const outputs = [await generate(id), await generate(id)];
        assert.equal(mock.counts(HTTP).http - before.http, 2);
        assert.deepEqual(received(HTTP).map((x) => x.authorization), ['Bearer DUMMY_FIXTURE_HTTP', 'Bearer DUMMY_FIXTURE_HTTP']);
        return { sessionID: id, outputs, pluginTested: false };
      });
      if (!opts['http-only']) await test('ws.native_fixture_smoke', async () => {
        const id = await session(WS); const before = mock.counts(WS);
        const outputs = [await prompt(id), await prompt(id)];
        checkWS(WS, before, { upgrades: 1, frames: 2, token: 'DUMMY_FIXTURE_WS' });
        return { sessionID: id, outputs, pluginTested: false, connectionID: sockets(WS).at(-1).connectionID };
      });
    } else {
      let httpSession;
      await group([
        ['http.lazy_first_use', async () => {
          httpSession = await session();
          assert.equal(await commandCount(HTTP), 0, 'Session creation must not eagerly run the command');
          assert.equal(mock.counts(HTTP).http, 0);
          return { sessionID: httpSession, commandInvocations: 0 };
        }],
        ['http.cache_A_A', async () => {
          const outputs = [await generate(httpSession), await generate(httpSession)];
          assert.deepEqual(received(HTTP).map((x) => x.authorization), ['Bearer DUMMY_A', 'Bearer DUMMY_A']);
          assert.equal(await commandCount(HTTP), 1);
          return { sessionID: httpSession, outputs, commandInvocations: 1 };
        }],
        ['http.ttl_rotation_same_session', async () => {
          await set(HTTP, 'DUMMY_B'); const age = await expire(HTTP);
          const before = await commandCount(HTTP); const output = await generate(httpSession);
          checkAuth(HTTP, 'DUMMY_B'); assert.equal(await commandCount(HTTP), before + 1);
          return { sessionID: httpSession, output, ...age };
        }],
        ['http.concurrent_singleflight', async () => {
          const ids = await Promise.all([session(), session(), session()]);
          await set(HTTP, 'DUMMY_CONCURRENT', { delayMs: 750 }); await expire(HTTP);
          const before = await commandCount(HTTP); const requestsBefore = mock.counts(HTTP).http;
          const launchedAt = Date.now();
          const outputs = await Promise.all(ids.map((id) => generate(id)));
          assert.equal(await commandCount(HTTP), before + 1, 'Concurrent callers must share ONE command process');
          assert.deepEqual(received(HTTP).slice(requestsBefore).map((x) => x.authorization), Array(ids.length).fill('Bearer DUMMY_CONCURRENT'));
          return { sessionIDs: ids, launchedAt, outputs, mintDelayMs: 750, commandDelta: 1 };
        }],
        ...['exit', 'timeout', 'blank'].map((mode, index) => [`http.expired_${mode}_fails_closed`, async () => {
          await set(HTTP, 'DUMMY_DO_NOT_USE', { mode });
          if (index === 0) await expire(HTTP);
          const count = mock.counts(HTTP).http; const commands = await commandCount(HTTP);
          const output = await generate(httpSession, { failure: true });
          assert.equal(mock.counts(HTTP).http, count, 'A failed refresh reached the upstream or fell back to the expired key');
          assert.equal(await commandCount(HTTP), commands + 1);
          return { sessionID: httpSession, mode, output, upstreamDelta: 0 };
        }]),
        ['http.recovery_C', async () => {
          await set(HTTP, 'DUMMY_C'); const output = await generate(httpSession); checkAuth(HTTP, 'DUMMY_C');
          return { sessionID: httpSession, output };
        }],
        ['http.401_invalidates_without_retry', async () => {
          const before = mock.counts(HTTP).http; const commands = await commandCount(HTTP);
          mock.controls.unauthorized.set(HTTP, 1);
          const failed = await generate(httpSession, { failure: true });
          assert.equal(mock.counts(HTTP).http, before + 1, '401 must not silently auto-retry/fallback');
          assert.equal(await commandCount(HTTP), commands);
          assert.equal(received(HTTP).at(-1).status, 401); checkAuth(HTTP, 'DUMMY_C');
          await set(HTTP, 'DUMMY_D'); const recovered = await generate(httpSession);
          checkAuth(HTTP, 'DUMMY_D'); assert.equal(await commandCount(HTTP), commands + 1);
          assert.equal(mock.counts(HTTP).http, before + 2);
          return { sessionID: httpSession, failed, recovered, authorizations: received(HTTP).slice(before).map((x) => x.authorization) };
        }],
        ['http.new_session_shares_fresh_D', async () => {
          const before = await commandCount(HTTP); const id = await session(); const output = await generate(id);
          checkAuth(HTTP, 'DUMMY_D'); assert.equal(await commandCount(HTTP), before);
          return { sessionID: id, output, commandDelta: 0 };
        }],
      ]);
      await test('http.final_hook_overrides_native_auth', async () => {
        const id = await session('rotating-native'); const output = await generate(id);
        checkAuth('rotating-native', 'DUMMY_NATIVE_FRESH');
        return { sessionID: id, output, configuredDummyAuth: 'DUMMY_NATIVE_STALE' };
      });
      await test('http.configurable_header_and_prefix', async () => {
        const id = await session('rotating-header'); const output = await generate(id);
        assert.equal(received('rotating-header').at(-1).apiKeyHeader, 'Token DUMMY_CUSTOM_HEADER');
        return { sessionID: id, output, header: 'x-api-key', prefix: 'Token ' };
      });
      await test('http.json_expiresIn_shortens_TTL', async () => {
        const id = await session('rotating-json'); const first = await generate(id);
        checkAuth('rotating-json', 'DUMMY_JSON_A');
        await set('rotating-json', 'DUMMY_JSON_B', { mode: 'json', expirySeconds: 1.5 });
        const age = await expire('rotating-json', 1.5); const second = await generate(id);
        checkAuth('rotating-json', 'DUMMY_JSON_B'); assert.equal(await commandCount('rotating-json'), 2);
        return { sessionID: id, outputs: [first, second], ...age };
      });
      for (const kind of ['unix', 'iso']) await test(`http.json_expiresAt_${kind}`, async () => {
        const provider = `rotating-${kind}`; const id = await session(provider); const before = mock.counts(provider).http;
        const failed = await generate(id, { failure: true });
        assert.equal(mock.counts(provider).http, before, 'Already-expired JSON credentials must never reach upstream');
        const token = `DUMMY_${kind.toUpperCase()}_FRESH`;
        await set(provider, token, { mode: 'json', expirySeconds: 60, expiryKind: kind });
        const recovered = await generate(id); checkAuth(provider, token);
        return { sessionID: id, failed, recovered };
      });
      await test('http.origin_denied_before_command', async () => {
        const provider = 'rotating-denied'; const id = await session(provider); const before = mock.counts(provider).http;
        const output = await generate(id, { failure: true });
        assert.equal(await commandCount(provider), 0); assert.equal(mock.counts(provider).http, before);
        return { sessionID: id, output, upstreamDelta: 0, commandDelta: 0 };
      });
      if (!opts['http-only']) {
        let wsSession;
        await group([
          ['ws.lazy_first_use', async () => {
            wsSession = await session(WS); assert.equal(await commandCount(WS), 0); assert.equal(mock.counts(WS).frames, 0);
            return { sessionID: wsSession, commandInvocations: 0 };
          }],
          ['ws.same_key_reuses_real_socket', async () => {
            const before = mock.counts(WS); const outputs = [await prompt(wsSession), await prompt(wsSession)];
            checkWS(WS, before, { upgrades: 1, frames: 2, token: 'DUMMY_WS_A' }); assert.equal(await commandCount(WS), 1);
            return { sessionID: wsSession, outputs, connectionID: sockets(WS).at(-1).connectionID };
          }],
          ['ws.TTL_new_key_reconnects', async () => {
            await set(WS, 'DUMMY_WS_B'); const age = await expire(WS);
            const before = mock.counts(WS); const commands = await commandCount(WS); const previous = sockets(WS).at(-1);
            const output = await prompt(wsSession);
            checkWS(WS, before, { token: 'DUMMY_WS_B' }); assert.equal(await commandCount(WS), commands + 1);
            await poll(() => previous.closedAt, { timeoutMs: 2000, signal: abort.signal, label: 'old WS affinity socket close' });
            return { sessionID: wsSession, output, oldConnectionID: previous.connectionID, oldClosedAt: previous.closedAt,
              newConnectionID: sockets(WS).at(-1).connectionID, ...age };
          }],
          ['ws.failed_refresh_no_new_frame', async () => {
            await set(WS, 'DUMMY_WS_BLOCKED', { mode: 'exit' }); await expire(WS);
            const before = mock.counts(WS); const commands = await commandCount(WS);
            const output = await prompt(wsSession, { failure: true });
            checkWS(WS, before, { upgrades: 0, frames: 0 }); assert.equal(await commandCount(WS), commands + 1);
            return { sessionID: wsSession, output, frameDelta: 0, upgradeDelta: 0 };
          }],
          ['ws.recovery_C', async () => {
            await set(WS, 'DUMMY_WS_C'); const before = mock.counts(WS); const output = await prompt(wsSession);
            checkWS(WS, before, { token: 'DUMMY_WS_C' }); return { sessionID: wsSession, output };
          }],
          ['ws.new_session_shares_fresh_cache', async () => {
            const commands = await commandCount(WS); const id = await session(WS); const before = mock.counts(WS);
            const output = await prompt(id); checkWS(WS, before, { token: 'DUMMY_WS_C' }); assert.equal(await commandCount(WS), commands);
            return { sessionID: id, output, commandDelta: 0 };
          }],
        ]);
        let guardSession;
        await group([
          ['ws.expired_between_handshake_and_send_is_blocked', async () => {
            guardSession = await session(GUARD);
            const delayMs = dynamic[GUARD].ttlSeconds * 1000 + 600;
            mock.controls.upgradeDelay.set(GUARD, delayMs);
            const before = mock.counts(GUARD); const output = await prompt(guardSession, { failure: true });
            checkWS(GUARD, before, { upgrades: 1, frames: 0, token: 'DUMMY_GUARD_A' });
            const connection = sockets(GUARD).at(-1);
            assert.ok(connection.acceptedAt, 'The TCP connection never completed a real 101 Upgrade');
            assert.ok(connection.acceptedAt - connection.requestedAt >= delayMs - 50);
            assert.equal(await commandCount(GUARD), 1, 'Send guard must reject the expired handshake lease, not mint a key for an already-authenticated socket');
            return { sessionID: guardSession, output, handshakeDelayMs: delayMs, frameDelta: 0, connectionID: connection.connectionID };
          }],
          ['ws.send_guard_recovery_reconnects', async () => {
            await set(GUARD, 'DUMMY_GUARD_B'); const before = mock.counts(GUARD); const output = await prompt(guardSession);
            checkWS(GUARD, before, { token: 'DUMMY_GUARD_B' });
            return { sessionID: guardSession, output };
          }],
        ]);
      } else report.tests.push({ name: 'ws.matrix', status: 'skip', reason: 'Explicit --http-only; WebSocket NOT tested.' });
    }
    await test('same_private_server_PID_and_fixture_integrity', async () => {
      const after = (await server.api.call('server.info')).data;
      report.pidAfter = after.pid;
      assert.equal(after.pid, report.pidBefore); assert.equal(after.version, report.serverVersion);
      assert.equal(server.child.exit, undefined, 'Owned foreground server unexpectedly exited');
      assert.deepEqual(mock.errors, [], 'Wire fixture detected malformed requests or frames');
      if (!opts['runtime-probe']) assert.deepEqual(await fingerprint(opts.plugin), report.artifactSha256, 'Built plugin modules changed during the run; evidence is not for one artifact');
      return { before: report.pidBefore, after: after.pid, version: after.version };
    });
  } catch (error) {
    report.tests.push({ name: 'preflight_or_harness', status: 'fail', error: diagnostic(error) });
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.commandEvents = Object.fromEntries(await Promise.all(Object.entries(stateFiles).map(async ([id, file]) => [id, await calls(file)])));
    report.commandInvocations = Object.fromEntries(Object.entries(report.commandEvents).map(([id, events]) => [id, events.filter((x) => x.event === 'start').length]));
    report.upstream = mock ? { requests: mock.requests, upgrades: mock.upgrades, errors: mock.errors, counts: mock.counts() } : null;
    report.serverLogTail = server ? diagnostic(server.child.stderr + server.child.stdout) : null;
    report.cleanup = {};
    try { await stopOwned(server?.child); report.cleanup.serverExited = !server || !!server.child.exit; }
    catch (error) { report.cleanup.error = diagnostic(error); }
    try { report.cleanup.fixturePIDsForceStopped = await stopFixtureCommands(Object.values(stateFiles)); }
    catch (error) { report.cleanup.fixtureError = diagnostic(error); }
    try { await mock?.close(); report.cleanup.mockClosed = true; }
    catch (error) { report.cleanup.mockError = diagnostic(error); }
    if (box && !opts['keep-temp']) {
      try { await box.remove(); report.cleanup.tempRemoved = true; }
      catch (error) { report.cleanup.tempError = diagnostic(error); }
    } else if (box) report.cleanup.tempKeptAt = box.root;
    if (Object.keys(report.cleanup).some((key) => key.toLowerCase().includes('error'))) report.tests.push({ name: 'cleanup', status: 'fail', error: JSON.stringify(report.cleanup) });
    report.counts = Object.fromEntries(['pass', 'fail', 'skip'].map((status) => [status, report.tests.filter((test) => test.status === status).length]));
    report.interrupted = interrupted;
    report.status = report.counts.fail ? 'fail' : opts['runtime-probe'] ? 'fixture-probe-pass-not-plugin-acceptance' : opts['http-only'] ? 'http-only-pass' : 'pass';
    report.runtimeSeconds = (Date.now() - startedAt) / 1000;
  }
  return report;
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.help) { help(); return; }
  let report;
  if (opts['self-test']) {
    const { selfTest } = await import('./fixtures/self-test.mjs');
    report = await selfTest(projectRoot);
  } else {
    report = { schemaVersion: 1, generatedAt: new Date().toISOString(), requestedBinaries: opts.binaries, runs: [] };
    for (const binary of opts.binaries) {
      const run = await runBinary(binary, opts); report.runs.push(run);
      if (run.interrupted) break;
    }
    report.status = report.runs.length !== opts.binaries.length || report.runs.some((run) => run.counts.fail || run.interrupted) ? 'fail' : 'selected-mode-passed';
    report.artifactConsistentAcrossVersions = opts['runtime-probe'] ? null : report.runs.every((run) =>
      JSON.stringify(run.artifactSha256) === JSON.stringify(report.runs[0].artifactSha256));
    if (report.artifactConsistentAcrossVersions === false) {
      report.status = 'fail'; report.artifactError = 'Plugin modules changed between version runs; rerun against one build.';
    }
    report.fullPluginMatrixPassed = report.status !== 'fail' && !opts['runtime-probe'] && !opts['http-only'] && report.runs.every((run) => run.status === 'pass');
    report.comparison = report.runs.map(({ clientVersion, serverVersion, pidBefore, pidAfter, counts, runtimeSeconds, status }) => ({ clientVersion, serverVersion, pidBefore, pidAfter, counts, runtimeSeconds, status }));
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.output) {
    await mkdir(path.dirname(opts.output), { recursive: true });
    await writeFile(opts.output, output, { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, report: opts.output,
      ...(report.comparison ? { comparison: report.comparison, fullPluginMatrixPassed: report.fullPluginMatrixPassed } : { counts: report.counts }) }, null, 2));
  } else process.stdout.write(output);
  if (report.status === 'fail') process.exitCode = 1;
}

main().catch((error) => { console.error(diagnostic(error)); process.exitCode = 1; });
