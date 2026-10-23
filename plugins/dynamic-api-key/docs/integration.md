# Dynamic API key build and integration guide

These are maintainer procedures, not user installation steps. For installation, use the [plugin README](../README.md); for runtime configuration and safety, use the [reference](reference.md). Previously recorded results are in the [verification history](verification.md).

Run commands from `plugins/dynamic-api-key/` in the source checkout. Do not change a user's real OpenCode configuration or restart a shared service to test this package.

## Build and package

Use Node.js >=22.15 for the full set of checks, including upstream Host discovery. The runtime's declared Node minimum and historical Node 20 coverage are separate from that tool requirement.

```sh
npm ci
npm run typecheck
npm test
npm run build
mkdir -p .artifacts
npm pack --pack-destination .artifacts
```

The build produces `dist/index.js` and declarations. The package contract produces `.artifacts/opencode-dynamic-api-key-0.1.0.tgz`; its file allowlist includes `server.js`, `dist/`, `README.md`, `examples/`, and necessary npm metadata. Source, tests, integration scripts, test logs, and credentials are not runtime package contents. Use this plugin directory's lockfile; the root lockfile belongs to installer tooling.

For a clean-consumer check, install the actual tarball in an explicitly selected disposable directory, not the user's live configuration:

```sh
npm install --prefix /absolute/path/clean-install --omit=dev /absolute/path/opencode-dynamic-api-key-0.1.0.tgz
```

Use `/absolute/path/clean-install/node_modules/opencode-dynamic-api-key` as the plugin directory for the full integration harness. The installed package must include its real `server.js`; a test-created replacement wrapper is not proof that the distributable works.

### Source checks

- `src/config.ts`: strict validation.
- `src/command.ts`: bounded subprocess execution and output parsing.
- `src/key-manager.ts`: in-memory single-flight leases.
- `src/index.ts`: registration with public types and lifecycle cleanup.
- `tests/`: `node:test` with `tsx`, real Node child processes for timeout/large-output/abort/descendant behavior, injected clocks for boundaries/concurrency, and mock contexts for HTTP/WebSocket hook contracts.

Typechecking uses published `@opencode/plugin@2.0.32` types, not a fabricated host interface. A compiled-package ESM import or passing mock context test does not establish real OpenCode server integration.

## Private-server integration harness

Entry point: [scripts/integration.mjs](../scripts/integration.mjs), with support files under [scripts/fixtures](../scripts/fixtures/README.md). The harness uses Node built-ins rather than `ws`, does not install dependencies, and does not modify user configuration or existing services.

Requirements: **Linux**, **Node >=22**, and an **OpenCode v2 executable**. Full mode also needs `dist/index.js` and installed local dependencies. The script does not wait for another worker, build the package, or install anything over the network. It refuses host configuration under `/etc/opencode` as described below.

### Three evidence levels

```sh
# Test command fixtures, real HTTP/SSE, and RFC6455 framing only.
# This does not need the compiled plugin or prove host integration.
node scripts/integration.mjs --self-test

# Use a real OpenCode server and native HTTP/WS provider with a fixed dummy key.
# This validates the API/schema/wire fixture, not the dynamic plugin.
node scripts/integration.mjs --runtime-probe --binary /absolute/path/opencode

# With the compiled package and dependencies ready, run the full plugin matrix.
node scripts/integration.mjs \
  --binary /absolute/path/opencode-old \
  --binary /absolute/path/opencode-new \
  --output .artifacts/integration.json
```

Use `--plugin /absolute/path/clean-install/node_modules/opencode-dynamic-api-key` to test a clean-installed package directly. Explicitly selecting a compiled JS file instead uses a **debug-only wrapper mode**. `--help` lists TTL, deadline, HTTP-only, and other controls.

A passing full-package report must show `pluginPackaging.mode: direct-package-directory` and `fullPluginMatrixPassed: true`. Exit 0 from `--http-only`, `--runtime-probe`, or a JS-file wrapper does not mean the complete distributable passed. Failures return nonzero. Inspect `mode`, per-case results, and the full-matrix flag rather than relying on exit status alone.

### Actual acceptance paths

- **HTTP:** `session.create` followed by `session.generate` in the same session. Assert both `data.text === "DYNAMIC_KEY_OK"` and the Authorization header actually received by the mock upstream.
- **WebSocket:** `session.prompt`, `experimental.session.wait`, then `session.context`. Accept only a **new assistant message**. Record actual HTTP Upgrade authorization, connection IDs, each client `response.create` frame, and close times.
- `session.generate` uses HTTP even when the provider sets `transport=websocket`; it cannot prove WebSocket behavior. Sessionless `generate.text` bypasses Session hooks and is outside this matrix.
- The WebSocket provider's HTTP `/responses` requests are explicitly rejected by the mock, so HTTP fallback cannot masquerade as WebSocket success.
- Delay the **101 Upgrade response** so the handshake lease expires before the first send. Assert that a handshake happened but no upstream frame arrived. Recovery with a new key must reconnect.

### Matrix coverage

HTTP cases include lazy acquisition, A/A cache reuse, B after TTL, single-flight refresh across concurrent sessions for one provider, nonzero exit/timeout/blank-output failures with no upstream request, recovery with C, 401 without automatic replay followed by D on the next call, a new session sharing the refreshed cache, hook replacement of native auth, custom header/prefix, JSON `expiresIn` and Unix-seconds/ISO `expiresAt`, rejection of expired JSON, and origin validation before command execution.

WebSocket cases include lazy acquisition, same-key socket reuse, reconnection for a new key after TTL, failed refresh with no new frame, recovery, a new session sharing the key cache, and expiry between handshake/send with rejection and recovery. Each supplied OpenCode version gets its own private server, and cases check that its PID stays unchanged.

Reports include per-case pass/fail/skip, dummy keys, actual session IDs, command events/counts, Upgrade/frame counts, elapsed time, and compiled-JS SHA-256 consistency. These are synthetic loopback results, not real provider authentication or real balances.

### Directory-discovery regression

At v2.0.32 and v2.1.2, `core/src/config/plugin/source.ts` discards configured file paths with `configured plugin path must be a directory`. Configuring `plugins: [{package: "/.../dist/index.js", ...}]` is therefore not proof of loading.

By default, the harness configures this plugin's source package root as the directory, loading `dist/index.js` through the packaged `server.js`, without generating a substitute entry. Prefer `--plugin` pointing to the actual installed tarball directory for package acceptance. Only an explicit JS-file selection creates a temporary wrapper, and that mode is not installation acceptance.

### Isolation and cleanup

- Before startup, reject `/etc/opencode` if it is nonempty, unreadable, or not a directory. Do not read its configuration contents.
- Use a new minimal server/command environment rather than copying host TOKEN, PROXY, NODE_OPTIONS, OPENCODE_CONFIG, or similar variables. HOME, test HOME, all XDG roots, configuration, database, and TMPDIR are isolated.
- Use an empty local model catalog, disable model fetching/project config/Claude config/file watching/update, choose an explicit fake provider/model per session, deny tool permissions, and disable title/compaction helper agents.
- Start only `serve --hostname 127.0.0.1 --port 0`. Do not use `service`, a shared port, or discover/stop someone else's PID.
- Create temporary directories with `mkdtemp` under `$TMPDIR`, or the project's `.integration` when TMPDIR is unset. Retain only an explicit `--output` report; `--keep-temp` can preserve that run's dummy-only isolated files for diagnosis.
- In `finally`, close mock sockets, the process groups spawned by the harness, and fixture PIDs still holding that run's unique state argv. SIGINT, SIGTERM, and deadline expiry use the cleanup path too.
- This is **not an OS-level network sandbox**. Configured and observed test requests are loopback; reports explicitly state `networkSandbox: false`, not that the kernel blocked all possible external traffic.

Local reports can contain machine paths and process/session IDs and are not committed. Run only the probes within the authorized scope. Neither fixture tests nor private-server results establish real vendor token issuance, OAuth migration, arbitrary third-party plugin compatibility, or all possible title/compaction/retry combinations.
