import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_TEXT, createMockOpenAI, encodeFrame, frameReader } from './mock-openai.mjs';
import { calls, diagnostic, poll, sandbox, spawnOwned, stopFixtureCommands, stopOwned, writeState } from './runtime.mjs';

function openWebSocket(url, token, provider = 'fixture-self-test') {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const request = http.request(new URL('/v1/responses', url), {
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key,
        authorization: `Bearer ${token}`, 'x-integration-provider': provider },
    });
    const timer = setTimeout(() => request.destroy(new Error('fixture WebSocket handshake deadline')), 2500);
    request.once('error', (error) => { clearTimeout(timer); reject(error); });
    request.once('response', (response) => { clearTimeout(timer); response.destroy(); reject(new Error(`Not a 101 Upgrade: ${response.statusCode}`)); });
    request.once('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      try {
        assert.equal(response.headers['sec-websocket-accept'], createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
        const frames = []; const errors = [];
        const read = frameReader((frame) => frames.push(frame));
        socket.on('error', (error) => errors.push(diagnostic(error)));
        socket.on('data', (chunk) => { try { read(chunk); } catch (error) { errors.push(diagnostic(error)); socket.destroy(); } });
        if (head.length) read(head);
        resolve({ socket, frames, errors, send(value, opcode = 1) { socket.write(encodeFrame(typeof value === 'string' ? value : JSON.stringify(value), { masked: true, opcode })); } });
      } catch (error) { socket.destroy(); reject(error); }
    });
    request.end();
  });
}

export async function selfTest(projectRoot) {
  const startedAt = Date.now();
  const box = await sandbox(projectRoot);
  const state = path.join(box.root, 'fixture.state.json');
  const command = path.join(path.dirname(fileURLToPath(import.meta.url)), 'key-command.mjs');
  const mock = await createMockOpenAI();
  const children = []; const clients = [];
  const report = { schemaVersion: 1, mode: 'fixtures-only', status: 'running',
    coverage: { pluginAcceptance: false, privateOpenCodeServer: false, note: 'Only the command, real HTTP fixture and RFC6455 wire fixture are self-tested.' }, tests: [] };
  async function test(name, fn) {
    const start = Date.now(); const result = { name };
    try { result.evidence = await fn(); result.status = 'pass'; }
    catch (error) { result.status = 'fail'; result.error = diagnostic(error); }
    result.runtimeSeconds = (Date.now() - start) / 1000; report.tests.push(result);
  }
  async function invoke(input) {
    await writeState(state, input);
    const child = spawnOwned(process.execPath, [command, state], box); children.push(child);
    await poll(() => { if (child.error) throw child.error; return child.exit; }, { timeoutMs: 3000, label: 'fixture command exit' });
    return { code: child.exit.code, stdout: child.stdout, stderr: child.stderr };
  }
  const post = async (pathname, body, token = 'DUMMY_SELF_HTTP') => {
    const response = await fetch(`${mock.url}${pathname}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000), redirect: 'error' });
    return { status: response.status, text: await response.text() };
  };
  try {
    await test('command.text_state_rotation_and_invocations', async () => {
      assert.equal((await calls(state)).length, 0);
      assert.deepEqual(await invoke({ token: 'DUMMY_A' }), { code: 0, stdout: 'DUMMY_A\n', stderr: '' });
      assert.deepEqual(await invoke({ token: 'DUMMY_B' }), { code: 0, stdout: 'DUMMY_B\n', stderr: '' });
      const starts = (await calls(state)).filter((x) => x.event === 'start');
      assert.equal(starts.length, 2);
      assert.deepEqual(starts.map((x) => x.token), ['DUMMY_A', 'DUMMY_B']);
      return { tokens: starts.map((x) => x.token), invocations: starts.length };
    });
    await test('command.json_all_expiry_forms', async () => {
      const values = [];
      for (const expiryKind of ['relative', 'unix', 'iso']) {
        const output = await invoke({ token: 'DUMMY_JSON', mode: 'json', expiryKind, expirySeconds: 20 });
        assert.equal(output.code, 0);
        const value = JSON.parse(output.stdout); assert.equal(value.apiKey, 'DUMMY_JSON');
        if (expiryKind === 'relative') assert.equal(value.expiresIn, 20);
        else {
          const remaining = expiryKind === 'unix' ? value.expiresAt * 1000 - Date.now() : Date.parse(value.expiresAt) - Date.now();
          assert.ok(remaining > 15_000 && remaining <= 20_000);
        }
        values.push(value);
      }
      return { values };
    });
    await test('command.nonzero_and_blank', async () => {
      const failed = await invoke({ token: 'DUMMY_FAILURE', mode: 'exit' });
      assert.equal(failed.code, 17); assert.equal(failed.stdout, '');
      const blank = await invoke({ token: 'DUMMY_BLANK', mode: 'blank' });
      assert.equal(blank.code, 0); assert.equal(blank.stdout.trim(), '');
      return { nonzeroExit: failed.code, blankLength: blank.stdout.length };
    });
    await test('command.timeout_fixture_is_owned_and_terminable', async () => {
      await writeState(state, { token: 'DUMMY_HANG', mode: 'timeout' });
      const child = spawnOwned(process.execPath, [command, state], box); children.push(child);
      await poll(async () => (await calls(state)).some((x) => x.pid === child.child.pid && x.event === 'start'), { timeoutMs: 2000, label: 'timeout fixture started' });
      await stopOwned(child); assert.ok(child.exit); assert.equal(child.stdout, '');
      return { pid: child.child.pid, exit: child.exit };
    });
    await test('http.chat_json_sse_and_one_401', async () => {
      const normal = await post('/v1/chat/completions', { model: 'probe', messages: [{ role: 'user', content: 'ping' }] });
      assert.equal(normal.status, 200); assert.equal(JSON.parse(normal.text).choices[0].message.content, ASSISTANT_TEXT);
      const stream = await post('/v1/chat/completions', { model: 'probe', stream: true, messages: [] });
      assert.equal(stream.status, 200); assert.ok(stream.text.includes(ASSISTANT_TEXT)); assert.ok(stream.text.endsWith('data: [DONE]\n\n'));
      mock.controls.unauthorized.set('fixture-self-test', 1);
      assert.equal((await post('/v1/chat/completions', { model: 'probe' })).status, 401);
      assert.equal((await post('/v1/chat/completions', { model: 'probe' })).status, 200);
      assert.ok(mock.requests.every((x) => x.authorization === 'Bearer DUMMY_SELF_HTTP'));
      return { requests: mock.requests.slice(), assistantText: ASSISTANT_TEXT };
    });
    await test('http.responses_sse', async () => {
      const response = await post('/v1/responses', { model: 'probe', stream: true, input: [] });
      const events = response.text.split('\n').filter((x) => x.startsWith('data: ')).map((x) => JSON.parse(x.slice(6)));
      assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed');
      assert.equal(events.at(-1).response.output[0].content[0].text, ASSISTANT_TEXT);
      return { eventTypes: events.map((x) => x.type) };
    });
    await test('ws.real_upgrade_auth_reuse_reconnect_and_frames', async () => {
      const first = await openWebSocket(mock.url, 'DUMMY_WS_A'); clients.push(first);
      for (let index = 1; index <= 2; index++) {
        first.send({ type: 'response.create', model: 'probe', input: [] });
        await poll(() => first.frames.filter((x) => x.opcode === 1 && JSON.parse(x.payload).type === 'response.completed').length === index, { timeoutMs: 2000, label: 'real WS response' });
      }
      first.send('fixture_ping', 9);
      await poll(() => first.frames.some((x) => x.opcode === 10 && x.payload.toString() === 'fixture_ping'), { timeoutMs: 1000, label: 'WS pong' });
      first.socket.destroy();
      const second = await openWebSocket(mock.url, 'DUMMY_WS_B'); clients.push(second);
      second.send({ type: 'response.create', model: 'probe', input: [] });
      await poll(() => second.frames.some((x) => x.opcode === 1 && JSON.parse(x.payload).type === 'response.completed'), { timeoutMs: 2000, label: 'second real WS response' });
      assert.deepEqual(mock.upgrades.map((x) => x.authorization), ['Bearer DUMMY_WS_A', 'Bearer DUMMY_WS_B']);
      assert.deepEqual(mock.upgrades.map((x) => x.frames.length), [2, 1]);
      for (const client of clients) {
        assert.deepEqual(client.errors, []);
        const completed = client.frames.filter((x) => x.opcode === 1).map((x) => JSON.parse(x.payload)).filter((x) => x.type === 'response.completed');
        assert.ok(completed.every((x) => x.response.output[0].content[0].text === ASSISTANT_TEXT));
      }
      return { upgrades: mock.upgrades.map((x) => ({ auth: x.authorization, frames: x.frames.length })), assistantText: ASSISTANT_TEXT };
    });
    await test('ws.delayed_upgrade_gate', async () => {
      mock.controls.upgradeDelay.set('fixture-delay', 120);
      const client = await openWebSocket(mock.url, 'DUMMY_DELAY', 'fixture-delay'); clients.push(client);
      const connection = mock.upgrades.at(-1);
      assert.ok(connection.acceptedAt - connection.requestedAt >= 100);
      assert.equal(connection.frames.length, 0);
      return { delayMs: connection.acceptedAt - connection.requestedAt, framesBeforeSend: 0 };
    });
    await test('ws.frame_lengths_masks_and_TCP_splits', async () => {
      const sizes = [0, 1, 125, 126, 65535, 65536];
      for (const size of sizes) {
        const payload = Buffer.alloc(size, 97); const encoded = encodeFrame(payload, { masked: true });
        const decoded = []; const receive = frameReader((frame) => decoded.push(frame), { requireMask: true });
        for (let offset = 0; offset < encoded.length; offset += 73) receive(encoded.subarray(offset, offset + 73));
        assert.equal(decoded.length, 1); assert.deepEqual(decoded[0].payload, payload);
      }
      assert.throws(() => frameReader(() => {}, { requireMask: true })(encodeFrame('unmasked')));
      return { payloadSizes: sizes, maskRequired: true };
    });
    assert.deepEqual(mock.errors, []);
  } finally {
    for (const client of clients) client.socket.destroy();
    await Promise.all(children.map(stopOwned));
    await stopFixtureCommands([state]);
    await mock.close(); await box.remove();
  }
  report.counts = Object.fromEntries(['pass', 'fail'].map((status) => [status, report.tests.filter((test) => test.status === status).length]));
  report.status = report.counts.fail ? 'fail' : 'fixtures-pass-not-plugin-acceptance';
  report.runtimeSeconds = (Date.now() - startedAt) / 1000;
  return report;
}
