import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile, readFile, readdir, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { spawnSync } from "node:child_process"

// An optional sibling package path lets the same consumer checks cover both
// independently versioned Git packages. Nothing invokes OpenCode or account APIs.
const root = resolve(process.argv[2] || join(import.meta.dirname, ".."))
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"))
const copilot = manifest.name === "opencode-copilot-credits"
assert.ok(copilot || manifest.name === "opencode-dynamic-api-key", "Unexpected plugin package")
const preparationScripts = ["build", "prepare", "prepack", "install", "preinstall", "postinstall"]
function gitManifest(value) {
  for (const name of preparationScripts) assert.equal(Object.hasOwn(value.scripts ?? {}, name), false, `Git package must omit scripts.${name}`)
  assert.equal(Object.hasOwn(value, "workspaces"), false, "Git package must omit workspaces")
  assert.equal(typeof value.scripts?.compile, "string")
}
gitManifest(manifest)
assert.equal(manifest.version, lock.version)
assert.equal(manifest.version, lock.packages[""].version)
const artifactRoot = join(root, ".artifacts")
await mkdir(artifactRoot, { recursive: true })
const artifacts = await mkdtemp(join(artifactRoot, "pack-check-"))
const sandbox = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "opencode-package-consumer-"))
const consumer = join(sandbox, "consumer with spaces")
for (const path of [consumer, join(sandbox, "home"), join(sandbox, "tmp")]) await mkdir(path, { recursive: true })
const env = Object.fromEntries(["PATH", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]))
Object.assign(env, {
  HOME: join(sandbox, "home"), USERPROFILE: join(sandbox, "home"),
  TMPDIR: join(sandbox, "tmp"), TMP: join(sandbox, "tmp"), TEMP: join(sandbox, "tmp"),
  LANG: "C.UTF-8", NO_COLOR: "1",
  NPM_CONFIG_USERCONFIG: join(sandbox, "empty-user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: join(sandbox, "empty-global.npmrc"),
  NPM_CONFIG_CACHE: join(sandbox, "npm-cache"), NPM_CONFIG_UPDATE_NOTIFIER: "false",
})
await writeFile(env.NPM_CONFIG_USERCONFIG, "")
await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "")
const report = { name: manifest.name, version: manifest.version, artifacts, sandbox, consumer, commands: [], passed: false }
async function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
  await writeFile(join(artifacts, log), (result.stdout ?? "") + (result.stderr ?? "") + (result.error ? `\n${result.error.message}\n` : ""))
  report.commands.push({ command, args, exitCode: result.status, signal: result.signal, log: join(artifacts, log) })
  if (result.error || result.status !== 0) throw new Error(`${command} exited ${result.status}; see ${join(artifacts, log)}`)
  return result.stdout
}
async function npm(args, cwd, log) {
  // npm run supplies the JS entrypoint, including on Windows; no shell quoting
  // or test-only installer wrapper is involved in package installation.
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], cwd, log)
    : run("npm", args, cwd, log)
}
async function inventory(directory, prefix = "") {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = prefix + entry.name
    if (entry.isDirectory()) files.push(...await inventory(join(directory, entry.name), file + "/"))
    else {
      assert.ok(entry.isFile(), `Non-regular package file: ${file}`)
      files.push(file)
    }
  }
  return files.sort()
}
const npmFlags = ["--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=1", "--fetch-timeout=20000"]
try {
  // Pack the Git-facing root as-is. Deliberately do not compile or run any hook.
  const packed = JSON.parse(await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], root, "npm-pack.log"))
  assert.equal(packed.length, 1)
  assert.equal(packed[0].name, manifest.name)
  assert.equal(packed[0].version, manifest.version)
  const tarball = join(artifacts, packed[0].filename)
  report.tarball = tarball
  report.integrity = packed[0].integrity
  const names = packed[0].files.map(file => file.path).sort()
  assert.equal(new Set(names).size, names.length)
  const expected = ["README.md", "package.json", ...(await inventory(join(root, "dist"))).map(file => `dist/${file}`),
    ...(copilot ? ["LICENSE", ...["index", "server", "tui", "rpc"].flatMap(name => [`${name}.js`, `${name}.d.ts`])]
      : ["server.js", ...(await inventory(join(root, "examples"))).map(file => `examples/${file}`)])].sort()
  assert.deepEqual(names, expected, "Only canonical runtime files, declarations and documentation may be packed")
  assert.ok(names.every(name => !/(?:^|\/)(?:src|scripts|tests|node_modules|\.env|\.artifacts)(?:\/|$)/.test(name)))
  assert.ok(names.every(name => !/\.(?:ts|tsx)$/.test(name) || name.endsWith(".d.ts")))
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2) + "\n")
  await npm(["install", "--omit=dev", "--save-exact", ...npmFlags, tarball], consumer, "clean-install.log")
  const installed = join(consumer, "node_modules", manifest.name)
  report.installedPackage = installed
  assert.ok((await lstat(installed)).isDirectory())
  assert.deepEqual(await inventory(installed), names)
  report.files = {}
  for (const file of names) {
    const bytes = await readFile(join(installed, file))
    assert.deepEqual(bytes, await readFile(join(root, file)), `Installed bytes differ: ${file}`)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    assert.doesNotMatch(file + "\n" + text, /\p{Script=Han}/u, `Non-English package file: ${file}`)
    report.files[file] = createHash("sha256").update(bytes).digest("hex")
  }
  const installedManifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
  gitManifest(installedManifest)
  assert.equal(installedManifest.version, manifest.version)
  const resolution = `
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { Host } from '@opencode/plugin/host';
const name = ${JSON.stringify(manifest.name)};
const dir = fileURLToPath(new URL('./node_modules/' + name + '/', import.meta.url));
const consumer = fileURLToPath(new URL('.', import.meta.url));
const expected = {
  server: pathToFileURL(join(dir, 'server.js')).href,
  tui: ${copilot ? "pathToFileURL(join(dir, 'tui.js')).href" : "undefined"},
  rpc: ${copilot ? "pathToFileURL(join(dir, 'rpc.js')).href" : "undefined"},
};
for (const target of [{ directory: dir }, { directory: consumer, name }]) {
  const entries = Host.resolve(target);
  assert.deepEqual(entries, expected);
  console.log(JSON.stringify({ target, entries }));
}
const specifiers = ${JSON.stringify(copilot ? { "": "index.js", "/server": "server.js", "/tui": "tui.js", "/rpc": "rpc.js" } : { "": "dist/index.js", "/server": "server.js" })};
for (const [suffix, file] of Object.entries(specifiers)) {
  assert.equal(import.meta.resolve(name + suffix), pathToFileURL(join(dir, file)).href);
}
const primary = await import(name);
const server = await import(name + '/server');
assert.equal(primary.default, server.default);
assert.equal(server.default.id, ${JSON.stringify(copilot ? "copilot.credits.server" : "dynamic-api-key")});
${copilot ? `const rpc = await import(name + '/rpc');
assert.equal(rpc.Credits.id, 'copilot.credits');
assert.equal(rpc.Credits.methods.get.output, rpc.SnapshotSchema);
assert.equal(rpc.Credits.methods.get.input.parse({force: true}).force, true);` : `// Missing options must fail before any hook, command or credential access.
await assert.rejects(server.default.setup({ options: {}, location: { directory: consumer } }), /providers/);
console.log('PASS unconfigured dynamic options fail closed before hook registration');`}
console.log('PASS exact local/npm JS entries and shipped server imports');
`
  await writeFile(join(consumer, "resolve.mjs"), resolution)
  await run(process.execPath, ["resolve.mjs"], consumer, "entry-resolutions.log")

  // Add only consumer-side type tools/optional host peer types after the clean
  // runtime install was verified; none is bundled into the plugin archive.
  const tools = ["typescript", "@types/node", ...(copilot ? ["@opentui/core", "@opentui/solid", "solid-js"] : [])]
    .map(name => `${name}@${lock.packages[`node_modules/${name}`].version}`)
  // The SDK's declaration graph also needs JSON Schema types and, for TUI,
  // its optional theme peer. Supply real published types, never ambient stubs.
  tools.push("@types/json-schema@7.0.15")
  if (copilot) tools.push(`@opencode/theme@${lock.packages["node_modules/@opencode/plugin"].peerDependencies["@opencode/theme"]}`)
  await npm(["install", "--save-dev", "--include=dev", ...npmFlags, ...tools], consumer, "type-tools-install.log")
  const types = copilot ? `
import main from 'opencode-copilot-credits';
import server from 'opencode-copilot-credits/server';
import tui from 'opencode-copilot-credits/tui';
import { Credits, SnapshotSchema, type Snapshot } from 'opencode-copilot-credits/rpc';
const same: typeof main = server;
const id: string = tui.id;
const contractID: 'copilot.credits' = Credits.id;
const snapshot: Snapshot = SnapshotSchema.parse({});
const remaining: number | null = snapshot.remaining;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const typed: IsAny<Snapshot> = false;
// @ts-expect-error Snapshot quantities must not degrade to any.
const invalid: Snapshot['used'] = 'not-a-number';
// @ts-expect-error The public status remains a validated enum.
const invalidStatus: Snapshot['status'] = 'not-a-status';
// @ts-expect-error The TUI entry must preserve its plugin definition.
const invalidID: number = tui.id;
// @ts-expect-error Server setup requires a native context.
main.setup({});
const input = Credits.methods.get.input.parse({ force: true });
// @ts-expect-error The RPC input is typed, not any.
input.force = 'yes';
void [same, id, contractID, remaining, typed, invalid, invalidStatus, invalidID];
` : `
import main, { setupDynamicApiKey, WS_LEASE_LIMIT } from 'opencode-dynamic-api-key';
import server from 'opencode-dynamic-api-key/server';
const same: typeof main = server;
const id: string = server.id;
const bound: number = WS_LEASE_LIMIT;
// @ts-expect-error The shipped server definition is not any.
const invalidID: number = server.id;
// @ts-expect-error Setup requires the native context, not guessed options.
setupDynamicApiKey({});
void [same, id, bound, invalidID];
`
  await writeFile(join(consumer, "consumer.ts"), types)
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      noEmit: true, skipLibCheck: false, types: ["node"], allowImportingTsExtensions: false },
    include: ["consumer.ts"],
  }, null, 2) + "\n")
  await run(process.execPath, [join(consumer, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer, "declaration-consumer.log")
  // Installing type tools must not mutate the already-verified plugin files.
  for (const [file, hash] of Object.entries(report.files)) {
    assert.equal(createHash("sha256").update(await readFile(join(installed, file))).digest("hex"), hash, file)
  }
  report.passed = true
  console.log(`PASS ${manifest.name}@${manifest.version}: ${names.length} runtime files, exact local/npm Host.resolve, clean typed consumer\n${tarball}\n${installed}`)
} catch (error) {
  report.error = error.message
  throw error
} finally {
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2) + "\n")
  await writeFile(join(artifactRoot, "pack-check.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(`Report: ${join(artifacts, "report.json")}`)
}
