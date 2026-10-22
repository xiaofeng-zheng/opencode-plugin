import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"

// Bun's host transform excludes node_modules. Precompile the JSX with precisely
// the OpenTUI universal Solid preset; keep host runtime imports external.
const root = resolve(import.meta.dirname, "..")
const destination = join(root, ".artifacts/package")
await rm(destination, { recursive: true, force: true })
await mkdir(join(destination, "src"), { recursive: true })
const files = ["index.ts", "server.ts", "tui.tsx", "rpc.ts", "LICENSE", "README.md", "package.json", ...(await readdir(join(root, "src"))).map(name => `src/${name}`)]
const hashes = {}
for (const file of files) {
  if (file.startsWith("src/") && !/\.tsx?$/.test(file)) throw new Error(`Unexpected runtime file: ${file}`)
  let bytes = await readFile(join(root, file))
  let output = file
  if (file === "src/tui.tsx") {
    const result = await transformAsync(bytes.toString(), {
      filename: file, configFile: false, babelrc: false,
      presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [typescript]],
    })
    if (!result?.code) throw new Error("Solid compilation failed")
    bytes = Buffer.from(result.code + "\n")
    output = "src/tui.js"
  }
  if (file === "tui.tsx") bytes = Buffer.from(bytes.toString().replace("./src/tui.tsx", "./src/tui.js"))
  hashes[output] = createHash("sha256").update(bytes).digest("hex")
  await writeFile(join(destination, output), bytes)
}
await writeFile(join(root, ".artifacts/build-manifest.json"), JSON.stringify(hashes, null, 2) + "\n")
console.log(`Staged ${files.length} files for standard Bun OpenCode 2.1.2: ${destination}`)
