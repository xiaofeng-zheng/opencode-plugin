import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import {
  parseArgs, configDirectory, selectServerConfig, planConfig, readOptions,
  atomicWrite, commitPrepared, acquireLock, assertManagedTarget,
} from '../scripts/install.mjs';

const slug = 'copilot-credits';
const name = 'opencode-copilot-credits';
async function fixture(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'opencode-installer-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function plan(file, target, options) {
  return planConfig(file, { slug, target, options });
}
async function managed(dir, value) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.opencode-plugin-install.json'), JSON.stringify({ format: 1, slug, packageName: name }));
  await writeFile(join(dir, 'runtime.txt'), value);
}

test('arguments require an explicit known plugin and reject ambiguous flags', () => {
  assert.deepEqual(parseArgs(['copilot-credits']), { slug });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['dynamic-api-key', '--options', 'options.json', '--config-dir', 'user config', '--opencode', '/bin/opencode']), {
    slug: 'dynamic-api-key', optionsFile: 'options.json', configDir: 'user config', opencode: '/bin/opencode',
  });
  for (const args of [[], ['all'], ['copilot-credits', 'dynamic-api-key'], ['copilot-credits', '--options'], ['copilot-credits', '--unknown'], ['copilot-credits', '--config-dir', 'a', '--config-dir', 'b']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('user-level paths respect explicit, OpenCode, and XDG settings', () => {
  assert.equal(configDirectory({}, { HOME: '/users/test' }), '/users/test/.config/opencode');
  assert.equal(configDirectory({}, { HOME: '/users/test', XDG_CONFIG_HOME: '/custom/config' }), '/custom/config/opencode');
  assert.equal(configDirectory({}, { OPENCODE_CONFIG_DIR: '/custom/opencode' }), '/custom/opencode');
  assert.equal(configDirectory({ configDir: '/explicit config' }, { OPENCODE_CONFIG_DIR: '/other' }), '/explicit config');
  assert.throws(() => configDirectory({}, { XDG_CONFIG_HOME: 'relative' }));
});

test('selects existing JSON or JSONC and refuses conflicting source layers', async t => {
  const dir = await fixture(t);
  assert.equal(await selectServerConfig(dir), join(dir, 'opencode.jsonc'));
  await writeFile(join(dir, 'opencode.json'), '{}');
  assert.equal(await selectServerConfig(dir), join(dir, 'opencode.json'));
  await writeFile(join(dir, 'opencode.jsonc'), '{}');
  await assert.rejects(selectServerConfig(dir), /both|Both/);
  assert.equal(await readFile(join(dir, 'opencode.json'), 'utf8'), '{}');
});

test('new config uses a directory entry and explicit options', async t => {
  const dir = await fixture(t);
  const target = join(dir, 'installed plugins', name);
  const result = await plan(join(dir, 'opencode.jsonc'), target, { refreshSeconds: 60 });
  assert.equal(result.before, null);
  assert.deepEqual(parse(result.after).plugins, [{ package: target, options: { refreshSeconds: 60 } }]);
  await assert.rejects(readFile(result.path), { code: 'ENOENT' });
});

test('JSONC update preserves unrelated settings, comments, and target options', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.jsonc');
  const text = '{\n  // Model selection must stay unchanged.\n  "model": "provider/model#variant",\n  "permissions": [{"action":"shell","effect":"ask","resource":"*"}],\n  "plugins": [\n    "another-plugin",\n    { "package": "opencode-copilot-credits@0.0.1", "options": {\n      // Keep the user\'s refresh choice.\n      "refreshSeconds": 120,\n    } },\n    "-unrelated.*",\n  ],\n}\n';
  await writeFile(file, text);
  const target = join(dir, 'installed', name);
  const result = await plan(file, target);
  assert.deepEqual(parse(result.after), { ...parse(text), plugins: ['another-plugin', { package: target, options: { refreshSeconds: 120 } }, '-unrelated.*'] });
  assert.ok(result.after.includes('// Model selection must stay unchanged.'));
  assert.ok(result.after.includes('// Keep the user\'s refresh choice.'));
  assert.deepEqual(result.options, { refreshSeconds: 120 });
  assert.equal(await readFile(file, 'utf8'), text);
});

test('repeated update is byte-idempotent and explicit options replace only the target options', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.json');
  const target = join(dir, 'installed', name);
  const original = '{"plugins":[{"package":' + JSON.stringify(target) + ',"options":{"refreshSeconds":120}}],"providers":{"keep":{"value":1}}}\n';
  await writeFile(file, original);
  assert.equal((await plan(file, target)).after, original);
  const changed = await plan(file, target, { refreshSeconds: 0 });
  assert.deepEqual(parse(changed.after).plugins[0].options, { refreshSeconds: 0 });
  assert.deepEqual(parse(changed.after).providers, { keep: { value: 1 } });
});

test('recognizes local directory/file URL and Git subdirectory entries without removing other plugins', async t => {
  const dir = await fixture(t);
  const old = join(dir, 'old plugin');
  await mkdir(old);
  await writeFile(join(old, 'package.json'), JSON.stringify({ name }));
  const target = join(dir, 'installed', name);
  const specs = [old, pathToFileURL(old).href, './old plugin', 'github:xiaofeng-zheng/opencode-plugin#main::path:plugins/copilot-credits', 'git+https://github.com/xiaofeng-zheng/opencode-plugin.git#main::path:plugins/copilot-credits'];
  for (const spec of specs) {
    const file = join(dir, 'opencode.json');
    await writeFile(file, JSON.stringify({ plugins: [spec, 'opencode-copilot-credits-other', 'github:other/repo#main::path:plugins/copilot-credits'] }));
    const entries = parse((await plan(file, target)).after).plugins;
    assert.equal(entries.length, 3, spec);
    assert.deepEqual(entries[0], { package: target });
    assert.equal(entries[1], 'opencode-copilot-credits-other');
    assert.equal(entries[2], 'github:other/repo#main::path:plugins/copilot-credits');
  }
});

test('deduplicates equivalent entries and refuses conflicting options unless explicitly replaced', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.json');
  const target = join(dir, 'installed', name);
  await writeFile(file, JSON.stringify({ plugins: [name, { package: name + '@0.1.0' }, 'keep'] }));
  assert.deepEqual(parse((await plan(file, target)).after).plugins, [{ package: target }, 'keep']);
  await writeFile(file, JSON.stringify({ plugins: [{ package: name, options: { refreshSeconds: 60 } }, { package: name + '@0.1.0', options: { refreshSeconds: 90 } }] }));
  await assert.rejects(plan(file, target), /conflicting options/);
  const result = await plan(file, target, { refreshSeconds: 0 });
  assert.deepEqual(parse(result.after).plugins, [{ package: target, options: { refreshSeconds: 0 } }]);
});

test('invalid JSONC, duplicate keys, malformed entries and non-object options fail without writes', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.jsonc');
  const values = ['{"plugins": [}', '[]', '{"plugins":false}', '{"plugins":[],"plugins":[]}', '{"providers":{"x":1,"x":2}}', '{"plugins":[false]}', '{"plugins":[{"options":{}}]}', '{"plugins":[{"package":"opencode-copilot-credits","options":null}]}'];
  for (const text of values) {
    await writeFile(file, text);
    await assert.rejects(plan(file, join(dir, name)));
    assert.equal(await readFile(file, 'utf8'), text);
  }
});

test('options files accept only JSON objects and errors never include their content', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'options.json');
  await writeFile(file, '{"refreshSeconds":0}');
  assert.deepEqual(await readOptions(file), { refreshSeconds: 0 });
  for (const text of ['[]', 'null', '{"PRIVATE_SENTINEL"']) {
    await writeFile(file, text);
    await assert.rejects(readOptions(file), error => !error.message.includes('PRIVATE_SENTINEL'));
  }
});

test('config symlinks are refused rather than replaced or followed', async t => {
  const dir = await fixture(t);
  const actual = join(dir, 'actual.json');
  const link = join(dir, 'opencode.json');
  await writeFile(actual, '{}');
  await symlink(actual, link);
  await assert.rejects(plan(link, join(dir, name)), /symbolic link/);
  assert.equal(await readFile(actual, 'utf8'), '{}');
});

test('managed target checks protect existing user directories and symlinks', async t => {
  const dir = await fixture(t);
  const target = join(dir, slug);
  assert.equal(await assertManagedTarget(target, slug), false);
  await mkdir(target);
  await writeFile(join(target, 'user.txt'), 'keep');
  await assert.rejects(assertManagedTarget(target, slug), /not managed/);
  assert.equal(await readFile(join(target, 'user.txt'), 'utf8'), 'keep');
  const owned = join(dir, 'owned');
  await managed(owned, 'old');
  assert.equal(await assertManagedTarget(owned, slug), true);
  await symlink(owned, join(dir, 'link'));
  await assert.rejects(assertManagedTarget(join(dir, 'link'), slug), /symbolic link/);
});

test('transaction installs runtime, preserves private backup and performs no-op config update on rerun', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.json');
  await writeFile(file, '{"model":"keep"}\n', { mode: 0o640 });
  const destination = join(dir, 'installed', slug);
  const stage = join(dir, 'stage');
  await managed(stage, 'new');
  const config = await plan(file, join(destination, 'node_modules', name));
  const result = await commitPrepared({ stage, destination, plans: [config], slug });
  assert.equal(await readFile(join(destination, 'runtime.txt'), 'utf8'), 'new');
  assert.equal(await readFile(file, 'utf8'), config.after);
  assert.equal(result.backups.length, 1);
  assert.equal(await readFile(result.backups[0], 'utf8'), '{"model":"keep"}\n');
  assert.equal((await stat(result.backups[0])).mode & 0o777, 0o600);
  const stage2 = join(dir, 'stage2');
  await managed(stage2, 'updated');
  const again = await plan(file, join(destination, 'node_modules', name));
  const repeated = await commitPrepared({ stage: stage2, destination, plans: [again], slug });
  assert.deepEqual(repeated.backups, []);
  assert.equal(await readFile(file, 'utf8'), config.after);
  assert.equal(await readFile(join(destination, 'runtime.txt'), 'utf8'), 'updated');
});

test('concurrent config edits are detected before promotion', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.json');
  const destination = join(dir, 'installed', slug);
  await managed(destination, 'old');
  await writeFile(file, '{}');
  const config = await plan(file, join(destination, 'node_modules', name));
  await writeFile(file, '{"model":"changed elsewhere"}');
  const stage = join(dir, 'stage');
  await managed(stage, 'new');
  await assert.rejects(commitPrepared({ stage, destination, plans: [config], slug }), /changed during installation/);
  assert.equal(await readFile(join(destination, 'runtime.txt'), 'utf8'), 'old');
  assert.equal(await readFile(file, 'utf8'), '{"model":"changed elsewhere"}');
});

test('failed second config write rolls back both package and first config', async t => {
  const dir = await fixture(t);
  const server = join(dir, 'opencode.json');
  const client = join(dir, 'cli.json');
  await writeFile(server, '{"model":"original"}');
  await writeFile(client, '{"theme":"original"}');
  const destination = join(dir, 'installed', slug);
  await managed(destination, 'old runtime');
  const stage = join(dir, 'stage');
  await managed(stage, 'new runtime');
  const plans = [await plan(server, join(destination, name)), await plan(client, join(destination, name))];
  let writes = 0;
  await assert.rejects(commitPrepared({ stage, destination, plans, slug }, {
    write: async (...args) => {
      if (++writes === 2) throw new Error('Synthetic second-write failure');
      return atomicWrite(...args);
    },
  }), /Synthetic second-write failure/);
  assert.equal(await readFile(server, 'utf8'), '{"model":"original"}');
  assert.equal(await readFile(client, 'utf8'), '{"theme":"original"}');
  assert.equal(await readFile(join(destination, 'runtime.txt'), 'utf8'), 'old runtime');
});

test('rollback removes newly-created config and runtime after a later write failure', async t => {
  const dir = await fixture(t);
  const server = join(dir, 'opencode.jsonc');
  const client = join(dir, 'cli.json');
  const destination = join(dir, 'installed', slug);
  const stage = join(dir, 'stage');
  await managed(stage, 'new');
  const plans = [await plan(server, join(destination, name)), await plan(client, join(destination, name))];
  let writes = 0;
  await assert.rejects(commitPrepared({ stage, destination, plans, slug }, {
    write: async (...args) => {
      if (++writes === 2) throw new Error('Synthetic write failure');
      return atomicWrite(...args);
    },
  }), /Synthetic write failure/);
  await assert.rejects(stat(server), { code: 'ENOENT' });
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('installation lock prevents concurrent writers and can be released', async t => {
  const dir = await fixture(t);
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /installation lock/);
  await release();
  const again = await acquireLock(dir);
  await again();
  assert.deepEqual(await readdir(dir), []);
});

test('duplicate removal preserves comments around adjacent entries and works with trailing commas', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.jsonc');
  const text = '{"plugins":["opencode-copilot-credits", /* keep comma, inside comment */ {"package":"opencode-copilot-credits"}, // keep next comment\n "unrelated", {"package":"opencode-copilot-credits"}, /* keep ending comment */ ]}';
  await writeFile(file, text);
  const result = await plan(file, join(dir, name));
  assert.deepEqual(parse(result.after).plugins, [{ package: join(dir, name) }, 'unrelated']);
  for (const comment of ['keep comma, inside comment', 'keep next comment', 'keep ending comment']) assert.ok(result.after.includes(comment));
});

test('failed installed-byte verification rolls back before removing the previous runtime', async t => {
  const dir = await fixture(t);
  const file = join(dir, 'opencode.json');
  const destination = join(dir, 'installed', slug);
  const stage = join(dir, 'stage');
  await writeFile(file, '{"model":"original"}');
  await managed(destination, 'old');
  await managed(stage, 'new');
  const config = await plan(file, join(destination, name));
  await assert.rejects(commitPrepared({ stage, destination, plans: [config], slug }, {
    verify: async () => { throw new Error('Synthetic byte-verification failure'); },
  }), /Synthetic byte-verification failure/);
  assert.equal(await readFile(file, 'utf8'), '{"model":"original"}');
  assert.equal(await readFile(join(destination, 'runtime.txt'), 'utf8'), 'old');
});
