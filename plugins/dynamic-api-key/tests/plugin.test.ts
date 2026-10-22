import test from 'node:test';
import assert from 'node:assert/strict';
import type { Plugin, Provider } from '@opencode/plugin';
import type { SessionHooks } from '@opencode/plugin/promise/session';
import type { ProviderEditor, ProviderRecord } from '@opencode/plugin/promise/provider';
import plugin, { setupDynamicApiKey, WS_LEASE_LIMIT } from '../src/index.js';
import { deferred, providerInput, safeError } from './helpers.js';

type Name = keyof SessionHooks;
function mock(options: Record<string, unknown> = { providers: { test: providerInput() } }, failAt = -1) {
  const hooks = new Map<string, (event: never) => void | Promise<void>>();
  const disposed: string[] = [];
  let count = 0;
  let transform: ((editor: ProviderEditor) => void) | undefined;
  const hook: Plugin.Context['session']['hook'] = async (name, callback, scope) => {
    if (++count === failAt) throw new Error('SECRET_REGISTRATION');
    const key = `${scope?.providerID}:${name}`;
    hooks.set(key, callback as (event: never) => void | Promise<void>);
    return { dispose: async () => { disposed.push(key); hooks.delete(key); } };
  };
  const registerTransform: Plugin.Context['provider']['transform'] = async callback => {
    transform = callback;
    return { dispose: async () => { disposed.push('transform'); transform = undefined; } };
  };
  // A focused mock only, not an alternate plugin interface or server integration.
  // The callback signatures above are the published v2.0.32 types.
  const context = {
    options, location: { directory: process.cwd() },
    session: { hook }, provider: { transform: registerTransform },
  } as unknown as Plugin.Context;
  return {
    context, hooks, disposed,
    transform: (editor: ProviderEditor) => { assert.ok(transform); transform(editor); },
    async fire<N extends Name>(name: N, event: SessionHooks[N], id = 'test') {
      const fn = hooks.get(`${id}:${name}`); assert.ok(fn, `registered ${name}`); await fn(event as never);
    },
  };
}
const scope = (session = 'session-1', kind: SessionHooks['http.request']['kind'] = 'primary', providerID = 'test') => ({
  sessionID: session as SessionHooks['http.request']['sessionID'],
  agent: 'agent-test' as SessionHooks['http.request']['agent'],
  model: { providerID, id: 'probe' } as SessionHooks['http.request']['model'], kind,
});
const http = (url = 'https://api.example.test/v1', session = 'session-1') => ({ ...scope(session), request: new Request(url) });
const ws = (session = 'session-1'): SessionHooks['experimental.ws.handshake'] => ({ ...scope(session), url: 'wss://api.example.test/v1/responses', headers: { authorization: 'native', AUTHORIZATION: 'duplicate', 'x-keep': 'untouched' } });
const send = (session = 'session-1') => ({ ...scope(session), frame: '{"type":"response.create","input":"unchanged"}' });

test('default export is a real Plugin.define plugin, no startup credential mint', async () => {
  assert.equal(plugin.id, 'dynamic-api-key'); assert.equal(typeof plugin.setup, 'function');
  let calls = 0; const m = mock();
  const cleanup = await setupDynamicApiKey(m.context, { run: async () => { calls++; return 'test-key'; } });
  assert.equal(calls, 0); assert.equal(m.hooks.size, 4);
  await cleanup(); assert.equal(m.disposed.length, 5); assert.equal(m.hooks.size, 0);
  await cleanup(); assert.equal(m.disposed.length, 5);
});

test('HTTP preserves request identity, URL/method/body/headers and overrides case-insensitively', async () => {
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { run: async () => 'test-key' });
  try {
    const request = new Request('https://api.example.test/v1?keep=true', {
      method: 'PATCH', body: 'binary-\u0000-content', headers: { aUtHoRiZaTiOn: 'native-secret', 'content-type': 'application/octet-stream', 'x-preserve': 'yes' },
    });
    const before = { ...scope(), request };
    await m.fire('http.request', before);
    assert.equal(before.request, request);
    assert.equal(request.method, 'PATCH'); assert.equal(request.url, 'https://api.example.test/v1?keep=true');
    assert.equal(await request.clone().text(), 'binary-\u0000-content');
    assert.equal(request.headers.get('Authorization'), 'Bearer test-key');
    assert.equal(request.headers.get('x-preserve'), 'yes'); assert.equal(request.headers.get('content-type'), 'application/octet-stream');
    assert.equal([...request.headers].filter(([k]) => k.toLowerCase() === 'authorization').length, 1);
  } finally { await cleanup(); }
});

test('custom header with empty prefix preserves other authentication header', async () => {
  const m = mock({ providers: { test: providerInput({ header: 'x-api-key', prefix: '' }) } });
  const cleanup = await setupDynamicApiKey(m.context, { run: async () => 'test-key' });
  try {
    const event = http(); event.request.headers.set('Authorization', 'leave-native'); event.request.headers.set('X-API-KEY', 'old');
    await m.fire('http.request', event);
    assert.equal(event.request.headers.get('authorization'), 'leave-native'); assert.equal(event.request.headers.get('x-api-key'), 'test-key');
    const handshake = { ...scope(), url: 'wss://api.example.test/v1', headers: { 'X-API-Key': 'old', 'x-api-key': 'duplicate' } };
    await m.fire('experimental.ws.handshake', handshake);
    assert.deepEqual(handshake.headers, { 'x-api-key': 'test-key' });
  } finally { await cleanup(); }
});

test('HTTP and WS reject origin before command, including lookalike hosts', async () => {
  let calls = 0; const m = mock();
  const cleanup = await setupDynamicApiKey(m.context, { run: async () => { calls++; return 'test-key'; } });
  try {
    await assert.rejects(m.fire('http.request', http('https://api.example.test.evil/v1')), safeError);
    await assert.rejects(m.fire('experimental.ws.handshake', { ...ws(), url: 'wss://evil.example/v1' }), safeError);
    assert.equal(calls, 0);
  } finally { await cleanup(); }
});

test('all Session kinds and physical HTTP retries check TTL; failures block and recover', async () => {
  let now = 0; let calls = 0; let broken = false;
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { now: () => now, run: async () => { calls++; if (broken) throw new Error('SECRET_MARKER'); return `key-${calls}`; } });
  try {
    for (const kind of ['primary', 'title', 'compaction', 'generate'] as const) {
      const event = { ...http(), kind }; await m.fire('http.request', event);
      assert.equal(event.request.headers.get('authorization'), 'Bearer key-1');
    }
    const retry = http(); now = 8000; broken = true;
    await assert.rejects(m.fire('http.request', retry), safeError);
    assert.equal(retry.request.headers.get('authorization'), null);
    broken = false; await m.fire('http.request', retry);
    assert.equal(retry.request.headers.get('authorization'), 'Bearer key-3'); assert.equal(calls, 3);
  } finally { await cleanup(); }
});

test('HTTP 401 invalidates only tracked generation, not a newer key or untracked request', async () => {
  let now = 0; let calls = 0;
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { now: () => now, run: async () => `key-${++calls}` });
  try {
    const a = http(); await m.fire('http.request', a);
    now = 8000; const b = http(); await m.fire('http.request', b);
    await m.fire('http.response', { ...a, response: new Response(null, { status: 401 }) });
    const c = http(); await m.fire('http.request', c); assert.equal(calls, 2);
    await m.fire('http.response', { ...http(), response: new Response(null, { status: 401 }) });
    await m.fire('http.response', { ...c, response: new Response(null, { status: 500 }) });
    const response = new Response('keep failure', { status: 401 });
    await m.fire('http.response', { ...b, response }); assert.equal(response.status, 401); assert.equal(calls, 2);
    const d = http(); await m.fire('http.request', d); assert.equal(calls, 3);
    // If another later hook replaced the header, our key was not used.
    d.request.headers.set('authorization', 'another-hook');
    await m.fire('http.response', { ...d, response: new Response(null, { status: 401 }) });
    await m.fire('http.request', http()); assert.equal(calls, 3);
  } finally { await cleanup(); }
});

test('WS same-key affinity headers, new-key headers, no frame rewrites, stale send blocks without mint', async () => {
  let now = 0; let calls = 0;
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { now: () => now, run: async () => `key-${++calls}` });
  try {
    const a = ws(); await m.fire('experimental.ws.handshake', a);
    assert.deepEqual(a.headers, { Authorization: 'Bearer key-1', 'x-keep': 'untouched' });
    const frame = send(); const original = frame.frame; await m.fire('experimental.ws.send', frame); assert.equal(frame.frame, original);
    const b = ws(); await m.fire('experimental.ws.handshake', b); assert.deepEqual(b.headers, a.headers); assert.equal(calls, 1);
    await m.fire('experimental.ws.send', send());
    now = 8000;
    await assert.rejects(m.fire('experimental.ws.send', send()), safeError); assert.equal(calls, 1);
    const c = ws(); await m.fire('experimental.ws.handshake', c);
    assert.equal(c.headers.Authorization, 'Bearer key-2'); await m.fire('experimental.ws.send', send());
    await assert.rejects(m.fire('experimental.ws.send', send('unknown-session')), safeError);
  } finally { await cleanup(); }
});

test('WS blocks invalidation/rotation between handshake and send, including same-key new generation', async () => {
  let now = 0; let calls = 0;
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { now: () => now, run: async () => { calls++; return 'same-key'; } });
  try {
    await m.fire('experimental.ws.handshake', ws());
    const a = http(); await m.fire('http.request', a);
    await m.fire('http.response', { ...a, response: new Response(null, { status: 401 }) });
    await m.fire('http.request', http('https://api.example.test/v1', 'new-session'));
    await assert.rejects(m.fire('experimental.ws.send', send()), safeError); assert.equal(calls, 2);
    await m.fire('experimental.ws.handshake', ws()); await m.fire('experimental.ws.send', send());
    now = 8000; await m.fire('http.request', http());
    await assert.rejects(m.fire('experimental.ws.send', send()), safeError); assert.equal(calls, 3);
  } finally { await cleanup(); }
});

test('WS bounded LRU evicts old identities and concurrent ambiguous handshakes fail closed', async () => {
  let gate = deferred<string>(); let calls = 0;
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { now: () => 0, run: async () => { calls++; return gate.promise; } });
  try {
    const first = m.fire('experimental.ws.handshake', ws()); const rejected = assert.rejects(first, safeError);
    await Promise.resolve();
    await assert.rejects(m.fire('experimental.ws.handshake', ws()), safeError);
    gate.resolve('test-key'); await rejected;
    await assert.rejects(m.fire('experimental.ws.send', send()), safeError);
    for (let i = 0; i <= WS_LEASE_LIMIT; i++) { await m.fire('experimental.ws.handshake', ws(`bounded-${i}`)); }
    await assert.rejects(m.fire('experimental.ws.send', send('bounded-0')), safeError);
    await m.fire('experimental.ws.send', send(`bounded-${WS_LEASE_LIMIT}`)); assert.equal(calls, 1);
  } finally { await cleanup(); }
});

test('WS abandoned handshake rejects one sequential retry then recovers without stale sends', async () => {
  let calls = 0;
  const m = mock();
  const cleanup = await setupDynamicApiKey(m.context, { now: () => 0, run: async () => { calls++; return 'test-key'; } });
  try {
    await m.fire('experimental.ws.handshake', ws());
    // Simulate connection failure/cancellation after this hook, before any send.
    await assert.rejects(m.fire('experimental.ws.handshake', ws()), safeError);
    await assert.rejects(m.fire('experimental.ws.send', send()), safeError);
    await m.fire('experimental.ws.handshake', ws());
    await m.fire('experimental.ws.send', send());
    assert.equal(calls, 1);
  } finally { await cleanup(); }
});

test('provider transform changes activation only, never disabled/missing providers or settings', async () => {
  const m = mock({ providers: { test: providerInput(), disabled: providerInput(), missing: providerInput() } });
  let calls = 0; const cleanup = await setupDynamicApiKey(m.context, { run: async () => { calls++; return 'secret'; } });
  try {
    const records = new Map<string, ProviderRecord>(['test', 'disabled', 'other'].map(id => [id, {
      provider: { id, name: id, activation: id === 'disabled' ? 'disabled' : 'auto', settings: { transport: 'http' } } as Provider.Info,
      models: new Map(),
    }]));
    const updated: string[] = [];
    const editor = {
      get: (id: string) => records.get(id),
      update: (id: string, cb: Parameters<ProviderEditor['update']>[1]) => { updated.push(id); cb(records.get(id)!.provider as Parameters<typeof cb>[0]); },
    } as ProviderEditor;
    m.transform(editor);
    assert.deepEqual(updated, ['test']); assert.equal(records.get('test')!.provider.activation, 'enabled');
    assert.equal(records.get('disabled')!.provider.activation, 'disabled'); assert.equal(records.get('other')!.provider.activation, 'auto');
    assert.deepEqual(records.get('test')!.provider.settings, { transport: 'http' }); assert.equal(calls, 0);
  } finally { await cleanup(); }
});

test('cleanup aborts pending hook, clears WS state and rejects captured late callbacks', async () => {
  const gate = deferred<string>(); let signal: AbortSignal | undefined;
  const m = mock(); const cleanup = await setupDynamicApiKey(m.context, { run: async (_c, s) => { signal = s; return gate.promise; } });
  const captured = m.hooks.get('test:experimental.ws.send')!;
  const pending = m.fire('http.request', http()); const rejected = assert.rejects(pending, safeError);
  await Promise.resolve(); const disposal = cleanup(); assert.equal(signal!.aborted, true);
  gate.resolve('late-secret'); await rejected; await disposal;
  assert.equal(m.hooks.size, 0); assert.equal(m.disposed.length, 5);
  await assert.rejects(async () => captured(send() as never), safeError);
});

test('partial registration failure rolls back already registered hooks', async () => {
  const m = mock(undefined, 3);
  await assert.rejects(setupDynamicApiKey(m.context), (e: unknown) => safeError(e) && !String(e).includes('SECRET_REGISTRATION'));
  assert.equal(m.hooks.size, 0); assert.equal(m.disposed.length, 3);
});
