import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
// Pacote checks build as well as the usual lifecycle names before packing Git
// dependencies. Even workspaces: [] takes its dependency-preparation branch.
const preparationScripts = ['build', 'prepare', 'prepack', 'install', 'preinstall', 'postinstall'];
const plugins = [
  { slug: 'copilot-credits', sdk: '2.1.2', entries: ['index', 'server', 'tui', 'rpc'] },
  { slug: 'dynamic-api-key', sdk: '2.0.32', entries: ['server'] },
];
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

function assertNoPreparation(manifest) {
  for (const name of preparationScripts) {
    assert.equal(Object.hasOwn(manifest.scripts ?? {}, name), false, `Git package must omit scripts.${name}`);
  }
  assert.equal(Object.hasOwn(manifest, 'workspaces'), false, 'Git package must omit workspaces, including []');
  assert.equal(typeof manifest.scripts?.compile, 'string', 'Developer compilation must use scripts.compile');
}

async function filesBelow(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(join(directory, entry.name), name + '/'));
    else {
      assert.ok(entry.isFile(), `Only regular distribution files are allowed: ${name}`);
      files.push(name);
    }
  }
  return files.sort();
}

async function expectedFiles(directory, plugin) {
  const sourceFiles = await filesBelow(join(directory, 'src'));
  assert.ok(sourceFiles.every(file => /\.(?:ts|tsx)$/.test(file)));
  const dist = sourceFiles.flatMap(file => {
    const stem = file.replace(/\.(?:ts|tsx)$/, '');
    return [`dist/${stem}.js`, `dist/${stem}.d.ts`];
  });
  return [
    'README.md', 'package.json', ...dist,
    ...plugin.entries.map(name => `${name}.js`),
    ...(plugin.slug === 'copilot-credits'
      ? ['LICENSE', ...plugin.entries.map(name => `${name}.d.ts`)]
      : (await filesBelow(join(directory, 'examples'))).map(name => `examples/${name}`)),
  ].sort();
}

async function assertRuntime(directory, plugin) {
  for (const entry of plugin.entries) {
    assert.ok(await exists(join(directory, `${entry}.js`)), `Missing root ${entry}.js`);
    for (const extension of ['ts', 'tsx', 'jsx', 'mts', 'cts', 'mjs', 'cjs']) {
      assert.equal(await exists(join(directory, `${entry}.${extension}`)), false, `Competing root ${entry}.${extension}`);
    }
  }
  for (const file of await filesBelow(join(directory, 'dist'))) {
    assert.match(file, /(?:\.js|\.d\.ts)$/, `Non-runtime dist file: ${file}`);
    const content = await readFile(join(directory, 'dist', file), 'utf8');
    // Covers import/export-from and import("...") in both JS and declarations.
    const imports = content.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g);
    for (const [, specifier] of imports) {
      assert.ok(specifier.endsWith('.js'), `${file} has an uncompiled relative specifier: ${specifier}`);
      const target = resolve(directory, 'dist', dirname(file), specifier);
      assert.ok(!relative(directory, target).startsWith('..'), `${file} imports outside its package`);
      const required = file.endsWith('.d.ts') ? target.replace(/\.js$/, '.d.ts') : target;
      assert.ok(await exists(required), `${file} has a missing import: ${specifier}`);
    }
  }
  if (plugin.slug === 'copilot-credits') {
    const tui = await readFile(join(directory, 'dist/tui.js'), 'utf8');
    assert.match(tui, /from ["']@opentui\/solid["']/);
    assert.match(tui, /from ["']solid-js["']/);
    assert.doesNotMatch(tui, /<text(?:\s|>)|react\/jsx-runtime/);
    const manifest = await json(join(directory, 'package.json'));
    assert.equal(manifest.main, './index.js');
    assert.equal(manifest.types, './index.d.ts');
    for (const entry of plugin.entries) {
      const key = entry === 'index' ? '.' : `./${entry}`;
      assert.equal(manifest.exports[key].import, `./${entry}.js`);
      assert.equal(manifest.exports[key].types, `./${entry}.d.ts`);
      assert.ok(await exists(join(directory, manifest.exports[key].types)));
    }
  }
}

test('the Git preparation guard rejects every trigger, including empty workspaces', () => {
  const valid = { scripts: { compile: 'developer-only' } };
  assert.doesNotThrow(() => assertNoPreparation(valid));
  for (const name of preparationScripts) {
    for (const value of ['', 'some-command']) {
      assert.throws(() => assertNoPreparation({ scripts: { ...valid.scripts, [name]: value } }), /must omit/);
    }
  }
  for (const workspaces of [[], {}, null]) {
    assert.throws(() => assertNoPreparation({ ...valid, workspaces }), /must omit workspaces/);
  }
});

for (const plugin of plugins) {
  const directory = join(root, 'plugins', plugin.slug);
  test(`${plugin.slug}: Git-facing manifest cannot trigger dependency preparation`, async () => {
    assertNoPreparation(await json(join(directory, 'package.json')));
  });

  test(`${plugin.slug}: independent version and SDK agree with locked root metadata`, async () => {
    const manifest = await json(join(directory, 'package.json'));
    const lock = await json(join(directory, 'package-lock.json'));
    assert.equal(manifest.version, '0.1.1');
    assert.equal(manifest.name, `opencode-${plugin.slug}`);
    assert.equal(manifest.dependencies['@opencode/plugin'], plugin.sdk);
    assert.equal(manifest.repository.directory, `plugins/${plugin.slug}`);
    for (const metadata of [lock, lock.packages['']]) {
      assert.equal(metadata.name, manifest.name);
      assert.equal(metadata.version, manifest.version);
      assert.equal(Object.hasOwn(metadata, 'workspaces'), false);
      for (const name of preparationScripts) assert.equal(Object.hasOwn(metadata.scripts ?? {}, name), false);
    }
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
    assert.equal(lock.packages['node_modules/@opencode/plugin'].version, plugin.sdk);
  });

  test(`${plugin.slug}: canonical root JS and compiled relative imports are Git-ready`, async () => {
    await assertRuntime(directory, plugin);
  });

  test(`${plugin.slug}: clean source root packs ready-to-load, English runtime bytes without scripts`, async t => {
    const sandbox = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'opencode-git-packaging-'));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const checkout = join(sandbox, 'clean source with spaces');
    const archiveDir = join(sandbox, 'archives');
    const unpacked = join(sandbox, 'unpacked');
    for (const dir of [checkout, archiveDir, unpacked]) await mkdir(dir, { recursive: true });
    // Copy only tracked or Git-eligible files, never ignored staging output or
    // node_modules. This also works before new dist files have been committed.
    const selected = [...new Set(execFileSync('git', [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', `plugins/${plugin.slug}/`,
    ], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
    for (const file of selected) {
      const source = join(root, file);
      if (!await exists(source)) continue; // A removed legacy root TS wrapper.
      assert.ok((await lstat(source)).isFile(), `Unexpected source link: ${file}`);
      const destination = join(checkout, relative(directory, source));
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
    }
    assert.equal(await exists(join(checkout, 'node_modules')), false);
    assert.equal(await exists(join(checkout, '.artifacts')), false);
    const env = {
      ...process.env,
      NPM_CONFIG_USERCONFIG: join(sandbox, 'empty-user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(sandbox, 'empty-global.npmrc'),
      NPM_CONFIG_CACHE: join(sandbox, 'npm-cache'),
      NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    };
    await writeFile(env.NPM_CONFIG_USERCONFIG, '');
    await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
    // Direct node --test on Windows cannot exec npm.cmd without a shell. Use
    // the ordinary npm JS entry shipped beside Node, or npm run's exact path.
    const npmCLI = process.env.npm_execpath || (process.platform === 'win32' ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js') : undefined);
    if (npmCLI) assert.ok(await exists(npmCLI), 'Run packaging verification through npm when Node has no adjacent npm CLI');
    const command = npmCLI ? process.execPath : 'npm';
    const args = [...(npmCLI ? [npmCLI] : []),
      'pack', '--ignore-scripts', '--json', '--pack-destination', archiveDir];
    const [packed, ...extra] = JSON.parse(execFileSync(command, args, {
      cwd: checkout, env, encoding: 'utf8', timeout: 60000,
    }));
    assert.deepEqual(extra, []);
    assert.equal(packed.name, `opencode-${plugin.slug}`);
    assert.ok(packed.files.every(file => !/(?:^|\/)(?:src|scripts|tests|node_modules|\.env|\.artifacts)(?:\/|$)/.test(file.path)), 'No development or test artifacts may enter a runtime archive');
    const expected = await expectedFiles(checkout, plugin);
    assert.deepEqual(packed.files.map(file => file.path).sort(), expected);
    execFileSync('tar', ['-xzf', join(archiveDir, packed.filename), '-C', unpacked], { timeout: 30000 });
    const installed = join(unpacked, 'package');
    assert.deepEqual(await filesBelow(installed), expected);
    for (const file of expected) {
      const bytes = await readFile(join(installed, file));
      assert.deepEqual(bytes, await readFile(join(checkout, file)), `Packed bytes differ: ${file}`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      assert.doesNotMatch(file + '\n' + text, /\p{Script=Han}/u, `Non-English package text: ${file}`);
    }
    const manifest = await json(join(installed, 'package.json'));
    assertNoPreparation(manifest);
    assert.equal(manifest.version, '0.1.1');
    await assertRuntime(installed, plugin);
    t.diagnostic(`${packed.name}@${packed.version}: ${expected.length} exact source/archive files; no build or install step`);
  });
}
