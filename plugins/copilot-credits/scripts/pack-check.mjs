import { mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dirname, "..")
const artifacts = join(root, ".artifacts")
const sandbox = join(root, ".test-sandbox/clean-install")
function run(command, args, cwd, log) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  const output = (result.stdout ?? "") + (result.stderr ?? "")
  return writeFile(join(artifacts, log), output).then(() => {
    if (result.status !== 0) throw new Error(`${command} exited ${result.status}; see .artifacts/${log}`)
    return result.stdout
  })
}
await mkdir(artifacts, { recursive: true })
const packed = JSON.parse(await run("npm", ["pack", "--json", "--pack-destination", artifacts], join(artifacts, "package"), "npm-pack.log"))
const tarball = join(artifacts, packed[0].filename)
const names = packed[0].files.map(file => file.path)
if (names.some(name => /artifacts|test|probe|scripts|node_modules|\.env|AGENTS|CLAUDE/.test(name))) throw new Error("Unexpected packed file")
await rm(sandbox, { recursive: true, force: true })
await mkdir(sandbox, { recursive: true })
await writeFile(join(sandbox, "package.json"), JSON.stringify({ private: true, type: "module" }))
await run("npm", ["install", "--no-audit", "--no-fund", tarball], sandbox, "clean-install.log")
const script = `
import assert from 'node:assert/strict';
import { Host } from '@opencode/plugin/host';
const dir = new URL('./node_modules/opencode-copilot-credits/', import.meta.url).pathname;
for (const target of [{ directory: dir }, { directory: new URL('.', import.meta.url).pathname, name: 'opencode-copilot-credits' }]) {
  const entries = Host.resolve(target);
  assert.ok(entries.server); assert.ok(entries.tui); assert.ok(entries.rpc);
  console.log(JSON.stringify({ target, entries }));
}
for (const spec of ['opencode-copilot-credits', 'opencode-copilot-credits/server', 'opencode-copilot-credits/tui', 'opencode-copilot-credits/rpc']) console.log(spec, import.meta.resolve(spec));
`
await writeFile(join(sandbox, "resolve.mjs"), script)
await run(process.execPath, ["resolve.mjs"], sandbox, "entry-resolutions.log")
const metadata = JSON.parse(await readFile(join(sandbox, "node_modules/opencode-copilot-credits/package.json"), "utf8"))
if (metadata.version !== "0.1.0") throw new Error("Wrong installed version")
console.log(`PASS clean tarball install + local/npm server,tui,rpc resolution\n${tarball}\n${sandbox}/node_modules/opencode-copilot-credits`)
