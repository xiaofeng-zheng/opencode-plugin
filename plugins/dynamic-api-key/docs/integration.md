# Build and verification

Run in `plugins/dynamic-api-key/` with Node.js >=22.15 and npm:

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run compile
npm pack --ignore-scripts
```

Commit generated `dist/` files with source changes. Keep the root `server.js` entry and omit Git preparation/lifecycle scripts so native Git installation needs no compiler. Unit tests exercise validation, real credential subprocesses, TTL/concurrency, and HTTP/WebSocket hook contracts.

## Private server checks

On Linux, with an explicitly selected OpenCode binary:

```sh
node scripts/integration.mjs --self-test
node scripts/integration.mjs --binary /absolute/path/opencode --output .artifacts/integration.json
```

Use `--plugin /absolute/path/installed/opencode-dynamic-api-key` to check a clean-installed package. Multiple `--binary` arguments compare versions. `--help` lists diagnostic modes and timeouts.

A complete run must report `pluginPackaging.mode: direct-package-directory` and `fullPluginMatrixPassed: true`. Self-tests, `--runtime-probe`, `--http-only`, or a JS-file debug wrapper are not full package acceptance.

The harness isolates HOME/XDG/config/database paths and starts private servers with a loopback HTTP/WebSocket fixture. It checks real requests/frames, cache reuse, rotation, expiry rejection, recovery, and unchanged server identity. No real vendor credentials or model services are used. This is not an OS network sandbox.

Reports are ignored local artifacts; scratch uses `$TMPDIR` with a project-local fallback. Cleanup stops only owned test processes. Do not alter user configuration or restart a shared service for these checks.
