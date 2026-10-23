import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { transformAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import ts from "typescript"

const root = resolve(import.meta.dirname, "..")
const destination = join(root, "dist")
const outputs = new Map()

async function sources(directory, prefix = "") {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name
    if (entry.isDirectory()) files.push(...await sources(join(directory, entry.name), name + "/"))
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) files.push(name)
    else throw new Error(`Unexpected runtime source: ${name}`)
  }
  return files.sort()
}

// Bun's host transform excludes node_modules. Emit plain JS for every runtime
// module, with Solid's OpenTUI universal transform only where JSX is present.
// No bundler is used: OpenCode, Solid and OpenTUI stay external host imports.
for (const file of await sources(join(root, "src"))) {
  const result = await transformAsync(await readFile(join(root, "src", file), "utf8"), {
    filename: `src/${file}`, configFile: false, babelrc: false,
    presets: [
      ...(file.endsWith(".tsx") ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }]] : []),
      [typescript, { rewriteImportExtensions: true }],
    ],
  })
  if (!result?.code) throw new Error(`Compilation failed: ${file}`)
  outputs.set(file.replace(/\.(?:ts|tsx)$/, ".js"), result.code + "\n")
}

// TypeScript's JS import-rewrite option does not rewrite declaration imports.
// Transform module specifiers in the emitted declaration AST, including import
// types, rather than rewriting unrelated string literal types or source code.
function declarationImports(context) {
  const specifier = value => value && ts.isStringLiteral(value) && /^\.{1,2}\//.test(value.text) && /\.tsx?$/.test(value.text)
    ? ts.factory.createStringLiteral(value.text.replace(/\.tsx?$/, ".js")) : value
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause, specifier(node.moduleSpecifier), node.attributes)
    }
    if (ts.isExportDeclaration(node)) {
      return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, specifier(node.moduleSpecifier), node.attributes)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      return ts.factory.updateImportTypeNode(node, ts.factory.createLiteralTypeNode(specifier(node.argument.literal)),
        node.attributes, node.qualifier, node.typeArguments, node.isTypeOf)
    }
    return ts.visitEachChild(node, visit, context)
  }
  return node => ts.visitNode(node, visit)
}
const configFile = ts.readConfigFile(join(root, "tsconfig.build.json"), ts.sys.readFile)
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"))
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(config.fileNames, config.options)
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)]
const emitted = program.emit(undefined, (filename, content) => {
  const file = relative(destination, filename).split("\\").join("/")
  if (isAbsolute(file) || file.startsWith("../") || !file.endsWith(".d.ts")) throw new Error(`Unexpected declaration output: ${filename}`)
  outputs.set(file, content)
}, undefined, true, { afterDeclarations: [declarationImports] })
diagnostics.push(...emitted.diagnostics)
if (emitted.emitSkipped || diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
  throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => "\n",
  }) || "Declaration compilation failed")
}

// Dist is a tracked, generated directory. Remove stale output only after both
// compilers succeeded; npm pack --ignore-scripts consumes these committed bytes.
await rm(destination, { recursive: true, force: true })
const hashes = {}
for (const [file, content] of [...outputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  await mkdir(dirname(join(destination, file)), { recursive: true })
  await writeFile(join(destination, file), content)
  hashes[`dist/${file}`] = createHash("sha256").update(content).digest("hex")
}
for (const file of ["index.js", "index.d.ts", "server.js", "server.d.ts", "tui.js", "tui.d.ts", "rpc.js", "rpc.d.ts", "package.json", "README.md", "LICENSE"]) {
  hashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex")
}
await mkdir(join(root, ".artifacts"), { recursive: true })
await writeFile(join(root, ".artifacts/build-manifest.json"), JSON.stringify(hashes, null, 2) + "\n")
console.log(`Compiled ${outputs.size} JS/declaration files: ${destination}`)
