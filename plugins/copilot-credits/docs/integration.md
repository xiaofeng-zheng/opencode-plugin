# Build and verification

Run in `plugins/copilot-credits/` with Node.js >=22.15 and npm:

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run compile
npm run pack:check
```

Commit generated `dist/` files with source changes. Native Git installation consumes precompiled JS and declarations from the package root; retain root JS entrypoints and omit Git preparation/lifecycle scripts. `pack:check` verifies archive contents, exact Host resolution, and a clean typed consumer; paths are recorded in `.artifacts/pack-check.json`.

## Private host checks

On Linux, with an explicitly selected OpenCode binary. `uv` supplies the test-only terminal emulator in a disposable environment:

```sh
uv run --no-project --with pyte==0.8.2 python scripts/host-probe.py --binary /absolute/path/opencode --expected-version 2.1.3 --tui
uv run --no-project --with pyte==0.8.2 python scripts/host-probe.py --binary /absolute/path/opencode --expected-version 2.1.3 --tui --session --synthetic-fixture
```

The probe reads the installed package from the pack report; `--package` overrides it. It isolates HOME/XDG/database paths, starts only its private server/TUI, and uses disconnected or synthetic account data with no model requests. A disabled MCP fixture supplies native layout anchors without launching an MCP process. Terminal-cell checks require exactly one credits display: after MCP on the same bottom row at home, or below MCP inside the session sidebar. Require slash details, RPC authentication, and zero process exit codes.

Reports stay in ignored `.artifacts/`; scratch directories use `$TMPDIR`. These tests do not establish real account access, native Windows/macOS, `mini`, or Node-distribution compatibility.
