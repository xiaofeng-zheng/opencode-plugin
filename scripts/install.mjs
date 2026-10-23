#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const MARKER = '.opencode-plugin-install.json';
const PLUGINS = Object.freeze({
  'copilot-credits': { name: 'opencode-copilot-credits', tui: true, packageDir: '.artifacts/package' },
  'dynamic-api-key': { name: 'opencode-dynamic-api-key', tui: false, packageDir: '.' },
});
const NPM_FLAGS = ['--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=1', '--fetch-timeout=20000'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
let parserPromise;
const jsonc = () => parserPromise ??= import('jsonc-parser');

const HELP = `Usage: ./install.sh <plugin-name> [options]

Plugins:
  copilot-credits    Copilot account quota in the full OpenCode TUI
  dynamic-api-key   Command-generated API keys for OpenCode sessions

Options:
  --options FILE     JSON object with plugin options; replaces this plugin's
                     options only. Existing options are retained when omitted.
                     Required for the first dynamic-api-key installation.
  --config-dir DIR   User-level config directory (default: OPENCODE_CONFIG_DIR,
                     then $XDG_CONFIG_HOME/opencode or ~/.config/opencode)
  --opencode PATH    OpenCode v2 executable (default: opencode on PATH)
  --help            Show this help without installing anything

Requires Node.js >=22.15, npm, and OpenCode v2. Run as the intended user,
without sudo. Installs/updates from this checkout; it does not run git pull.
Changed config files receive private .bak-* backups. The installer preserves
unrelated settings and never runs credential commands, reads account tokens,
makes model requests, or starts/restarts OpenCode services.
`;

export function parseArgs(args) {
  if (args.includes('--help')) return { help: true };
  const result = {};
  const flags = { '--options': 'optionsFile', '--config-dir': 'configDir', '--opencode': 'opencode' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (own(flags, arg)) {
      const key = flags[arg];
      if (own(result, key)) throw new Error(`Repeated option: ${arg}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      result[key] = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      if (result.slug) throw new Error('Select exactly one plugin per invocation.');
      if (!own(PLUGINS, arg)) throw new Error('Unknown plugin. Choose copilot-credits or dynamic-api-key.');
      result.slug = arg;
    }
  }
  if (!result.slug) throw new Error('Select a plugin: copilot-credits or dynamic-api-key. Use --help for usage.');
  return result;
}

export function configDirectory(options, env = process.env) {
  const home = env.HOME || homedir();
  const selected = options.configDir || env.OPENCODE_CONFIG_DIR;
  if (selected) return resolve(selected.startsWith('~/') ? join(home, selected.slice(2)) : selected);
  if (env.XDG_CONFIG_HOME && !isAbsolute(env.XDG_CONFIG_HOME)) throw new Error('XDG_CONFIG_HOME must be an absolute path.');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
}

async function metadata(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readState(path) {
  const info = await metadata(path);
  if (!info) return { text: null, mode: 0o600 };
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link config: ${path}`);
  if (!info.isFile()) throw new Error(`Expected a regular config file: ${path}`);
  if (info.nlink !== 1) throw new Error(`Refusing hard-linked config: ${path}`);
  return { text: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
}

export async function selectServerConfig(dir) {
  const plain = join(dir, 'opencode.json');
  const commented = join(dir, 'opencode.jsonc');
  const [a, b] = await Promise.all([metadata(plain), metadata(commented)]);
  if (a && b) throw new Error('Both opencode.json and opencode.jsonc exist. Reconcile these config layers before installing; neither has been changed.');
  return a ? plain : commented;
}

async function parseDocument(text, label, strict = false) {
  const { parseTree, getNodeValue } = await jsonc();
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: !strict, disallowComments: strict });
  if (errors.length || !tree || tree.type !== 'object') throw new Error(`Expected a valid ${strict ? 'JSON' : 'JSON/JSONC'} object: ${label}`);
  function check(node) {
    if (node.type === 'object') {
      const keys = new Set();
      for (const property of node.children || []) {
        const key = property.children[0].value;
        if (keys.has(key)) throw new Error(`Duplicate object keys in ${label}; refusing an ambiguous edit.`);
        keys.add(key);
      }
    }
    for (const child of node.children || []) check(child);
  }
  check(tree);
  // Match JSON.parse's ordinary object shape for stable option comparisons.
  return JSON.parse(JSON.stringify(getNodeValue(tree)));
}

export async function readOptions(path) {
  let text;
  try { text = await readFile(resolve(path), 'utf8'); }
  catch { throw new Error(`Cannot read options file: ${path}`); }
  return parseDocument(text, 'options file', true);
}

async function matchesPlugin(spec, { slug, target, configFile }) {
  const { name } = PLUGINS[slug];
  if (spec === target || spec === name || spec.startsWith(name + '@')) return true;
  const gitBase = /^(?:github:xiaofeng-zheng\/opencode-plugin|(?:git\+)?https:\/\/github\.com\/xiaofeng-zheng\/opencode-plugin(?:\.git)?|git\+ssh:\/\/git@github\.com\/xiaofeng-zheng\/opencode-plugin(?:\.git)?)(?=#|$)/;
  if (gitBase.test(spec) && spec.endsWith(`::path:plugins/${slug}`)) return true;
  let local;
  try {
    if (spec.startsWith('file://')) local = fileURLToPath(spec);
    else if (isAbsolute(spec)) local = spec;
    else if (spec.startsWith('./') || spec.startsWith('../')) local = resolve(dirname(configFile), spec);
    else if (spec.startsWith('~/')) local = join(homedir(), spec.slice(2));
    else return false;
    if (resolve(local) === resolve(target)) return true;
    const pkg = JSON.parse(await readFile(join(local, 'package.json'), 'utf8'));
    return pkg.name === name;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError || error.code?.startsWith('ERR_INVALID_FILE_URL')) return false;
    throw error;
  }
}

export async function planConfig(path, { slug, target, options }) {
  if (!own(PLUGINS, slug)) throw new Error('Unknown plugin.');
  if (options !== undefined && !object(options)) throw new Error('Plugin options must be an object.');
  const state = await readState(path);
  const otherName = basename(path) === 'opencode.json' ? 'opencode.jsonc' : basename(path) === 'opencode.jsonc' ? 'opencode.json' : undefined;
  const alternatePath = otherName ? join(dirname(path), otherName) : undefined;
  await checkAlternate({ alternatePath });
  let text = state.text ?? '{\n}\n';
  const original = await parseDocument(text, path);
  if (original.plugins !== undefined && !Array.isArray(original.plugins)) throw new Error(`The plugins field must be an array: ${path}`);
  const entries = original.plugins || [];
  const found = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== 'string' && (!object(entry) || typeof entry.package !== 'string')) throw new Error(`Invalid plugin entry in ${path}; refusing to discard it.`);
    if (object(entry) && own(entry, 'options') && !object(entry.options)) throw new Error(`Plugin options must be an object: ${path}`);
    if (await matchesPlugin(typeof entry === 'string' ? entry : entry.package, { slug, target, configFile: path })) found.push(index);
  }
  const first = found.length ? entries[found[0]] : undefined;
  const existing = object(first) ? first.options : undefined;
  if (options === undefined && found.some(index => !isDeepStrictEqual(object(entries[index]) ? entries[index].options : undefined, existing))) {
    throw new Error(`Multiple ${slug} entries have conflicting options in ${path}. Reconcile them or pass --options explicitly.`);
  }
  const chosenOptions = options === undefined ? existing : options;
  const { modify, applyEdits, parseTree, findNodeAtLocation, createScanner, SyntaxKind } = await jsonc();
  const indent = text.match(/(?:^|\n)([ \t]+)"/)?.[1] || '  ';
  const formattingOptions = { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 2 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  const edit = (key, value) => { text = applyEdits(text, modify(text, key, value, { formattingOptions })); };
  if (found.length) {
    for (const index of found.slice(1).reverse()) {
      // jsonc-parser 3.3.1 truncates a compact last array item incorrectly.
      // Remove only the duplicate's node and preceding comma, retaining comments.
      const array = findNodeAtLocation(parseTree(text), ['plugins']);
      const node = array.children[index];
      const previous = array.children[index - 1];
      const scanner = createScanner(text, false);
      scanner.setPosition(previous.offset + previous.length);
      let comma;
      while (scanner.getPosition() < node.offset) {
        const token = scanner.scan();
        if (token === SyntaxKind.CommaToken) { comma = scanner.getTokenOffset(); break; }
      }
      if (comma === undefined) throw new Error('Cannot safely remove a duplicate plugin entry.');
      text = applyEdits(text, [{ offset: comma, length: 1, content: '' }, { offset: node.offset, length: node.length, content: '' }]);
    }
    const index = found[0];
    if (object(first)) {
      if (first.package !== target) edit(['plugins', index, 'package'], target);
      if (options !== undefined && !isDeepStrictEqual(existing, options)) edit(['plugins', index, 'options'], options);
    } else {
      edit(['plugins', index], { package: target, ...(chosenOptions === undefined ? {} : { options: chosenOptions }) });
    }
  } else {
    const entry = { package: target, ...(chosenOptions === undefined ? {} : { options: chosenOptions }) };
    if (original.plugins === undefined) edit(['plugins'], [entry]);
    else edit(['plugins', -1], entry);
  }
  await parseDocument(text, path);
  return { path, before: state.text, mode: state.mode, after: text, options: chosenOptions, alternatePath };
}

async function temporaryFile(path, text, mode) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporary;
  } catch (error) {
    if (handle) await handle.close();
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function expectState(path, expected) {
  const current = await readState(path);
  if (current.text !== expected.text || current.mode !== expected.mode) throw new Error(`Config changed during installation/publication: ${path}`);
}

async function restoreDisplaced(path, backup, captured) {
  const info = await lstat(backup);
  // An unexpected concurrent symlink is retained/restored as a link, never read.
  const temporary = info.isSymbolicLink() ? undefined : await temporaryFile(path, captured.text, captured.mode);
  try {
    // Exclusive publication also protects a newer save during recovery.
    await link(temporary || backup, path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function atomicWrite(path, text, mode = 0o600, expected) {
  expected ??= await readState(path);
  const temporary = text === null ? undefined : await temporaryFile(path, text, mode);
  let backupDirectory, backup, captured, displaced = false;
  try {
    // Recheck after all temporary-file writes/fsyncs, at the publication boundary.
    await expected.validate?.();
    await expectState(path, expected);
    if (expected.text !== null) {
      backupDirectory = await mkdtemp(`${path}.bak-`);
      backup = join(backupDirectory, basename(path));
      // Capture the actual path entry atomically, not a stale copy of plan.before.
      await rename(path, backup);
      displaced = true;
      captured = await readState(backup);
      await chmod(backup, 0o600);
      if (captured.text !== expected.text || captured.mode !== expected.mode) throw new Error(`Config changed during publication: ${path}`);
    }
    await expected.validate?.();
    if (temporary) {
      try { await link(temporary, path); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Config was concurrently recreated during publication: ${path}`);
        throw error;
      }
    }
    return { backup };
  } catch (error) {
    if (displaced) {
      try { await restoreDisplaced(path, backup, captured); }
      catch { throw new Error(`${error.message} Recovery needs manual review; displaced config retained at ${backup}`); }
      throw new Error(`${error.message} Displaced config retained at ${backup}`);
    }
    throw error;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    if (backupDirectory && !displaced) await rm(backupDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function assertManagedTarget(path, slug) {
  const info = await metadata(path);
  if (!info) return false;
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link installation target: ${path}`);
  if (!info.isDirectory()) throw new Error(`Installation target is not a directory: ${path}`);
  try {
    const markerInfo = await lstat(join(path, MARKER));
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error('Invalid marker');
    const value = JSON.parse(await readFile(join(path, MARKER), 'utf8'));
    if (value.format !== 1 || value.slug !== slug || value.packageName !== PLUGINS[slug]?.name) throw new Error('Invalid marker');
  } catch {
    throw new Error(`Existing directory is not managed by this installer; refusing to replace it: ${path}`);
  }
  return true;
}

async function unchanged(plan) {
  await checkAlternate(plan);
  await expectState(plan.path, { text: plan.before, mode: plan.mode });
}

async function checkAlternate(plan) {
  if (plan.alternatePath && await metadata(plan.alternatePath)) throw new Error('Both opencode.json and opencode.jsonc exist: an alternate server config appeared. Reconcile the config layers before installing.');
}

export async function acquireLock(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, '.opencode-plugin-install.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`An installation lock already exists: ${path}. Wait for that installer; remove a stale lock only after confirming it is no longer running.`);
    throw error;
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
  finally { await handle.close(); }
  return () => rm(path);
}

export async function commitPrepared({ stage, destination, plans, slug }, { write = atomicWrite, verify = async () => {} } = {}) {
  if (new Set(plans.map(plan => plan.path)).size !== plans.length) throw new Error('Duplicate config write target.');
  for (const plan of plans) await unchanged(plan);
  const hadPrevious = await assertManagedTarget(destination, slug);
  const parent = dirname(destination);
  const parentInfo = await metadata(parent);
  if (parentInfo?.isSymbolicLink()) throw new Error(`Refusing symbolic link managed install directory: ${parent}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const changed = plans.filter(plan => plan.before !== plan.after);
  const backups = [];
  const previous = destination + '.previous-' + randomUUID();
  const written = [];
  let movedPrevious = false;
  let promoted = false;
  try {
    for (const plan of plans) await unchanged(plan);
    if (hadPrevious) { await rename(destination, previous); movedPrevious = true; }
    await rename(stage, destination);
    promoted = true;
    for (const plan of changed) {
      await unchanged(plan);
      const published = await write(plan.path, plan.after, plan.mode, {
        text: plan.before, mode: plan.mode, validate: () => checkAlternate(plan),
      });
      if (published?.backup) backups.push(published.backup);
      written.push(plan);
      if ((await readState(plan.path)).text !== plan.after) throw new Error(`Config verification failed: ${plan.path}`);
    }
    if (!await assertManagedTarget(destination, slug)) throw new Error('Promoted installation is missing.');
    await verify();
    for (const plan of plans) await checkAlternate(plan);
  } catch (error) {
    const rollbackErrors = [];
    for (const plan of written.reverse()) {
      try {
        await atomicWrite(plan.path, plan.before, plan.mode, { text: plan.after, mode: plan.mode });
      } catch { rollbackErrors.push(plan.path); }
    }
    try {
      if (promoted) await rm(destination, { recursive: true, force: true });
      if (movedPrevious) await rename(previous, destination);
    } catch { rollbackErrors.push(previous); }
    if (rollbackErrors.length) throw new Error(`Installation failed and rollback needs manual review: ${rollbackErrors.join(', ')}. Private config backups were retained.`);
    throw error;
  }
  if (movedPrevious) {
    await rm(previous, { recursive: true, force: true }).catch(() => console.warn(`Installed successfully, but the previous managed copy remains at ${previous}`));
  }
  return { backups, changed: changed.map(plan => plan.path) };
}

function run(command, args, { cwd = ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed${result.status === null ? '' : ` (exit ${result.status})`}. The installed plugin and configuration have not been replaced.`);
  }
  return result.stdout || '';
}

async function ensureParser() {
  try { await jsonc(); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    parserPromise = undefined;
    console.log('Installing the locked installer dependency...');
    run('npm', ['ci', ...NPM_FLAGS]);
    await jsonc();
  }
}

async function preparePackage(slug, stage) {
  const plugin = PLUGINS[slug];
  const source = join(ROOT, 'plugins', slug);
  console.log(`Preparing ${slug} from this checkout...`);
  run('npm', ['ci', '--include=dev', ...NPM_FLAGS], { cwd: source });
  run('npm', ['run', 'build'], { cwd: source });
  const packageDir = resolve(source, plugin.packageDir);
  const artifacts = join(source, '.artifacts');
  await mkdir(artifacts, { recursive: true });
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: packageDir, capture: true }));
  if (packed.length !== 1 || packed[0].name !== plugin.name) throw new Error('Packing produced an unexpected package.');
  const archive = join(artifacts, packed[0].filename);
  const files = packed[0].files.map(file => file.path);
  if (files.some(file => /(?:^|\/)(?:node_modules|tests|scripts|\.env(?:\.|$)|\.artifacts)(?:\/|$)/.test(file) || file.split('/').includes('..'))) throw new Error('Unexpected file in runtime package.');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
  console.log(`Installing ${plugin.name} runtime dependencies...`);
  run('npm', ['install', '--omit=dev', '--save-exact', ...NPM_FLAGS, archive], { cwd: stage });
  const installed = join(stage, 'node_modules', plugin.name);
  const info = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  if (info.name !== plugin.name || info.version !== packed[0].version) throw new Error('Installed package metadata does not match the archive.');
  const hashes = {};
  for (const file of files) {
    const original = await readFile(join(packageDir, file));
    const copy = await readFile(join(installed, file));
    if (!original.equals(copy)) throw new Error(`Installed package file differs from the packed source: ${file}`);
    hashes[file] = createHash('sha256').update(copy).digest('hex');
  }
  const required = plugin.tui ? ['server.ts', 'tui.tsx', 'rpc.ts', 'src/tui.js'] : ['server.js', 'dist/index.js', 'dist/config.js'];
  for (const file of required) if (!own(hashes, file)) throw new Error(`Missing runtime entry: ${file}`);
  if (plugin.tui && own(hashes, 'src/tui.tsx')) throw new Error('The distributed TUI must be precompiled.');
  await writeFile(join(stage, MARKER), JSON.stringify({ format: 1, slug, packageName: plugin.name, version: info.version, source: ROOT, installedAt: new Date().toISOString(), files: hashes }, null, 2) + '\n', { mode: 0o600 });
  return { installed, version: info.version, files: hashes };
}

async function verifyRuntime(destination, name, hashes) {
  for (const [file, hash] of Object.entries(hashes)) {
    const bytes = await readFile(join(destination, 'node_modules', name, file));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`Installed runtime verification failed: ${file}`);
  }
}

export async function install(options) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 15)) throw new Error('Node.js 22.15 or newer is required.');
  const binary = options.opencode || 'opencode';
  const version = run(binary, ['--version'], { capture: true });
  if (!/\bv?2\.\d+\.\d+\b/.test(version)) throw new Error('OpenCode v2 is required; this installer does not install or upgrade OpenCode.');
  run('npm', ['--version'], { capture: true });
  await ensureParser();
  const dir = configDirectory(options);
  const plugin = PLUGINS[options.slug];
  const destination = join(dir, 'installed-plugins', options.slug);
  const target = join(destination, 'node_modules', plugin.name);
  const release = await acquireLock(dir);
  let stage;
  try {
    await assertManagedTarget(destination, options.slug);
    const explicit = options.optionsFile ? await readOptions(options.optionsFile) : undefined;
    const serverFile = await selectServerConfig(dir);
    const plans = [await planConfig(serverFile, { slug: options.slug, target, options: explicit })];
    if (plugin.tui) plans.push(await planConfig(join(dir, 'cli.json'), { slug: options.slug, target, options: explicit }));
    if (options.slug === 'dynamic-api-key' && !object(plans[0].options?.providers)) {
      throw new Error('First-time dynamic-api-key installation requires --options with trusted provider command, TTL, and allowedOrigins. No credential command will be executed.');
    }
    stage = await mkdtemp(join(dir, '.opencode-plugin-stage-'));
    const prepared = await preparePackage(options.slug, stage);
    if (options.slug === 'dynamic-api-key') {
      const { parseConfig } = await import(pathToFileURL(join(prepared.installed, 'dist/config.js')).href);
      try { parseConfig(plans[0].options, dir); }
      catch { throw new Error('Invalid dynamic-api-key options. Check the provider command, TTL, allowedOrigins, and supported option fields. No credential command was executed.'); }
    }
    const result = await commitPrepared({ stage, destination, plans, slug: options.slug }, {
      verify: () => verifyRuntime(destination, plugin.name, prepared.files),
    });
    stage = undefined;
    console.log(`Installed/configured ${plugin.name}@${prepared.version}`);
    console.log(`Plugin directory: ${target}`);
    for (const plan of plans) console.log(`Config: ${plan.path}${plan.before === plan.after ? ' (unchanged)' : ''}`);
    for (const backup of result.backups) console.log(`Backup: ${backup}`);
    console.log('Package files and config entries verified. Runtime activation has not been checked.');
    console.log('No OpenCode service was started/restarted. Reopen the full TUI if needed; approve any service reload/restart separately.');
    return { target, configFiles: plans.map(plan => plan.path), backups: result.backups, version: prepared.version };
  } finally {
    try { if (stage) await rm(stage, { recursive: true, force: true }); }
    finally { await release(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await install(options);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
