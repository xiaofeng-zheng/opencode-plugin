import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseConfig, assertAllowedOrigin } from '../src/config.js';
import { config, providerInput, safeError } from './helpers.js';

test('configuration: defaults, fractional seconds, relative cwd and copied inputs', () => {
  const options = { providers: { openai: providerInput({ ttlSeconds: 0.5, refreshAheadSeconds: 0.1, timeoutSeconds: 0.2, cwd: 'mint', env: { TEST: 'value' } }) } };
  const c = parseConfig(options, process.cwd()).get('openai')!;
  assert.equal(c.ttlMs, 500); assert.equal(c.refreshAheadMs, 100); assert.equal(c.timeoutMs, 200);
  assert.equal(c.cwd, resolve(process.cwd(), 'mint'));
  assert.equal(c.header, 'Authorization'); assert.equal(c.prefix, 'Bearer '); assert.equal(c.format, 'text');
  const defaults = config({ refreshAheadSeconds: undefined, timeoutSeconds: undefined });
  assert.equal(defaults.refreshAheadMs, 0); assert.equal(defaults.timeoutMs, 15000);
  const alternate = config({ header: 'x-api-key', prefix: '', format: 'json', command: 'printf test-key' });
  assert.equal(alternate.prefix, ''); assert.equal(typeof alternate.command, 'string');
  assert.equal(c.env.TEST, 'value');
});

for (const [label, input] of Object.entries({
  missing: undefined, empty: {}, null: null, array: [], providersEmpty: { providers: {} },
  providersArray: { providers: [] }, unknownRoot: { providers: { x: providerInput() }, secretUnknown: true },
  emptyID: { providers: { '': providerInput() } }, nullProvider: { providers: { x: null } },
})) {
  test(`configuration rejects ${label} without reflecting values`, () => {
    assert.throws(() => parseConfig(input, process.cwd()), safeError);
  });
}

const invalid: Array<[string, unknown]> = [
  ['command', []], ['command', ['']], ['command', ['node', 1]], ['command', '   '], ['command', ['a\0b']],
  ['ttlSeconds', undefined], ['ttlSeconds', 0], ['ttlSeconds', -1], ['ttlSeconds', Infinity], ['ttlSeconds', NaN], ['ttlSeconds', '10'],
  ['refreshAheadSeconds', -1], ['refreshAheadSeconds', 10], ['refreshAheadSeconds', Infinity],
  ['timeoutSeconds', 0], ['timeoutSeconds', NaN], ['timeoutSeconds', '5'],
  ['cwd', 2], ['cwd', ''], ['env', { K: 1 }], ['env', { 'bad=key': 'x' }], ['env', { A: 'a\0b' }],
  ['header', 'bad name'], ['header', 'x:y'], ['header', 'x\n'], ['header', ''],
  ['prefix', 'a\r\nb'], ['prefix', '\x7f'], ['prefix', 2], ['format', 'yaml'],
  ['allowedOrigins', []], ['allowedOrigins', undefined], ['allowedOrigins', ['ftp://example.test']],
  ['allowedOrigins', ['https://api.example.test/']], ['allowedOrigins', ['https://u:p@api.example.test']],
  ['allowedOrigins', ['https://api.example.test/path']], ['allowedOrigins', ['https://api.example.test?x']],
  ['allowedOrigins', ['https://api.example.test#x']], ['allowedOrigins', ['https://API.example.test']],
  ['allowedOrigins', ['https://api.example.test:443']], ['secretUnknown', 'do-not-reflect-this'],
];
for (const [index, [field, value]] of invalid.entries()) {
  test(`configuration rejects invalid ${field} #${index}`, () => {
    assert.throws(() => config({ [field]: value }), (error: unknown) => {
      assert.ok(safeError(error));
      assert.doesNotMatch(String(error), /do-not-reflect|bad=key|api\.example|a\x00b/);
      return true;
    });
  });
}

test('origin allowlist is exact and checks WS http-equivalent origin', () => {
  const c = config({ allowedOrigins: ['https://api.example.test', 'http://127.0.0.1:8787'] });
  assertAllowedOrigin(c, 'https://api.example.test/v1/a');
  assertAllowedOrigin(c, 'wss://api.example.test/v1/responses', 'ws');
  assertAllowedOrigin(c, 'ws://127.0.0.1:8787/v1', 'ws');
  for (const url of ['https://api.example.test.evil/v1', 'https://api.example.test:4433', 'http://api.example.test', 'https://u:p@api.example.test', 'file:///secret', 'not-a-url', 'wss://api.example.test']) {
    assert.throws(() => assertAllowedOrigin(c, url), safeError);
  }
});
