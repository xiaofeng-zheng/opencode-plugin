import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import * as NodeModule from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));

test('OpenCode Host resolves the shipped local package server entry', {
  skip: 'registerHooks' in NodeModule ? false : 'Upstream Host test utility needs Node >=22.15; the runtime plugin does not import it',
}, async () => {
  const { Host } = await import('@opencode/plugin/host');
  assert.equal(Host.resolve({ directory: root }).server, pathToFileURL(path.join(root, 'server.js')).href);
});

test('npm publishes and exports the same server entry', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.files.includes('server.js'));
  assert.equal(manifest.exports['./server'].import, './server.js');
  assert.match(await readFile(path.join(root, 'server.js'), 'utf8'), /export\s*\{\s*default\s*\}\s*from\s*['"]\.\/dist\/index\.js['"]/);
});

test('all install examples use the native GitHub subdirectory package', async () => {
  for (const name of ['openai-http.json', 'openai-websocket.json', 'custom-provider.json']) {
    const config = JSON.parse(await readFile(path.join(root, 'examples', name), 'utf8'));
    const target = config.plugins[0].package as string;
    assert.equal(target, 'github:xiaofeng-zheng/opencode-plugins#main::path:plugins/dynamic-api-key', name);
  }
});
