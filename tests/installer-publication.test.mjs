import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite, commitPrepared, planConfig, selectServerConfig } from '../scripts/install.mjs';

const slug = 'copilot-credits';
const packageName = 'opencode-copilot-credits';
const originalText = '{"model":"original"}\n';
const editorText = '{"model":"concurrent-editor-save"}\n';

async function fixture(t) {
  const dir = await fs.mkdtemp(join(process.env.TMPDIR || tmpdir(), 'opencode-publication-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'opencode.json');
  const destination = join(dir, 'installed', slug);
  const stage = join(dir, 'stage');
  for (const [path, text] of [[destination, 'old'], [stage, 'new']]) {
    await fs.mkdir(path, { recursive: true });
    await fs.writeFile(join(path, '.opencode-plugin-install.json'), JSON.stringify({ format: 1, slug, packageName }));
    await fs.writeFile(join(path, 'runtime.txt'), text);
  }
  await fs.writeFile(file, originalText, { mode: 0o640 });
  const plan = await planConfig(file, { slug, target: join(destination, 'node_modules', packageName) });
  return { dir, file, destination, stage, plan };
}

function hook(t, name, implementation) {
  const original = fs[name];
  t.mock.method(fs, name, (...args) => implementation(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

function editDuringSync(t, f, enabled = () => true, save = () => fs.writeFile(f.file, editorText)) {
  let injected = false;
  hook(t, 'open', async (original, path, ...args) => {
    const handle = await original(path, ...args);
    if (typeof path === 'string' && dirname(path) === f.dir && path.endsWith('.tmp')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (!injected && enabled()) { injected = true; await save(); }
        return sync();
      };
    }
    return handle;
  });
  return () => injected;
}

async function snapshots(dir) {
  const paths = [];
  for (const name of await fs.readdir(dir)) {
    if (!name.includes('.bak-')) continue;
    const path = join(dir, name);
    if ((await fs.lstat(path)).isDirectory()) {
      for (const child of await fs.readdir(path)) paths.push(join(path, child));
    } else paths.push(path);
  }
  return Promise.all(paths.map(async path => ({ path, text: await fs.readFile(path, 'utf8'), mode: (await fs.stat(path)).mode & 0o777 })));
}

const commit = f => commitPrepared({ stage: f.stage, destination: f.destination, plans: [f.plan], slug });

test('an editor save during temporary-file sync is not overwritten', async t => {
  const f = await fixture(t);
  const injected = editDuringSync(t, f);
  await assert.rejects(commit(f), /changed|concurrent|publication/);
  assert.equal(injected(), true);
  assert.equal(await fs.readFile(f.file, 'utf8'), editorText);
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});

test('the actual file displaced after the final read is retained and restored on conflict', async t => {
  const f = await fixture(t);
  let injected = false;
  hook(t, 'rename', async (original, source, destination) => {
    if (!injected && source === f.file) {
      injected = true;
      await fs.writeFile(f.file, editorText);
    }
    return original(source, destination);
  });
  await assert.rejects(commit(f), /changed|concurrent|publication/);
  assert.equal(injected, true);
  assert.equal(await fs.readFile(f.file, 'utf8'), editorText);
  const backups = await snapshots(f.dir);
  assert.ok(backups.some(backup => backup.text === editorText));
  assert.ok(backups.every(backup => backup.mode === 0o600));
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});

test('a file recreated immediately before exclusive publication is never replaced', async t => {
  const f = await fixture(t);
  let injected = false;
  hook(t, 'link', async (original, source, destination) => {
    if (!injected && destination === f.file) {
      injected = true;
      await fs.writeFile(f.file, editorText, { flag: 'wx' });
    }
    return original(source, destination);
  });
  await assert.rejects(commit(f), /changed|concurrent|publication/);
  assert.equal(injected, true);
  assert.equal(await fs.readFile(f.file, 'utf8'), editorText);
  assert.ok((await snapshots(f.dir)).some(backup => backup.text === originalText));
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});

test('alternate server config creation after planning aborts before runtime promotion', async t => {
  const f = await fixture(t);
  assert.equal(await selectServerConfig(f.dir), f.file);
  const alternate = join(f.dir, 'opencode.jsonc');
  await fs.writeFile(alternate, editorText);
  await assert.rejects(commit(f), /Both opencode.json and opencode.jsonc|alternate server config/);
  assert.equal(await fs.readFile(f.file, 'utf8'), originalText);
  assert.equal(await fs.readFile(alternate, 'utf8'), editorText);
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});

test('alternate config creation inside the publication window is also detected', async t => {
  const f = await fixture(t);
  const alternate = join(f.dir, 'opencode.jsonc');
  const injected = editDuringSync(t, f, () => true, () => fs.writeFile(alternate, editorText));
  await assert.rejects(commit(f), /Both opencode.json and opencode.jsonc|alternate server config/);
  assert.equal(injected(), true);
  assert.equal(await fs.readFile(f.file, 'utf8'), originalText);
  assert.equal(await fs.readFile(alternate, 'utf8'), editorText);
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});

test('rollback publication also preserves a concurrent editor save', async t => {
  const f = await fixture(t);
  const client = join(f.dir, 'cli.json');
  await fs.writeFile(client, '{}');
  const clientPlan = await planConfig(client, { slug, target: join(f.destination, 'node_modules', packageName) });
  let rollingBack = false;
  const injected = editDuringSync(t, f, () => rollingBack);
  await assert.rejects(commitPrepared({ stage: f.stage, destination: f.destination, plans: [f.plan, clientPlan], slug }, {
    write: async (path, ...args) => {
      if (path === client) { rollingBack = true; throw new Error('Synthetic second-write failure'); }
      return atomicWrite(path, ...args);
    },
  }), /rollback needs manual review/);
  assert.equal(injected(), true);
  assert.equal(await fs.readFile(f.file, 'utf8'), editorText);
  assert.equal(await fs.readFile(client, 'utf8'), '{}');
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});

test('hard-linked config is refused without changing another pathname', async t => {
  const f = await fixture(t);
  const alias = join(f.dir, 'other-name.json');
  await fs.link(f.file, alias);
  await assert.rejects(planConfig(f.file, { slug, target: f.destination }), /hard-linked config/);
  assert.equal(await fs.readFile(alias, 'utf8'), originalText);
  assert.equal((await fs.stat(alias)).mode & 0o777, 0o640);
});

test('a concurrent symlink is restored as a link without reading or chmodding its target', async t => {
  const f = await fixture(t);
  const protectedFile = join(f.dir, 'synthetic-protected.json');
  await fs.writeFile(protectedFile, editorText, { mode: 0o640 });
  let injected = false;
  hook(t, 'rename', async (original, source, destination) => {
    if (!injected && source === f.file) {
      injected = true;
      await fs.rm(f.file);
      await fs.symlink(protectedFile, f.file);
    }
    return original(source, destination);
  });
  await assert.rejects(commit(f), /symbolic link/);
  assert.equal(injected, true);
  assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(protectedFile, 'utf8'), editorText);
  assert.equal((await fs.stat(protectedFile)).mode & 0o777, 0o640);
  assert.equal(await fs.readFile(join(f.destination, 'runtime.txt'), 'utf8'), 'old');
});
