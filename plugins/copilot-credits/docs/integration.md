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

On Linux, with an explicitly selected OpenCode binary:

```sh
python3 scripts/host-probe.py --binary /absolute/path/opencode --expected-version 2.1.3 --tui
python3 scripts/host-probe.py --binary /absolute/path/opencode --expected-version 2.1.3 --tui --session --synthetic-fixture
```

The probe reads the installed package from the pack report; `--package` overrides it. It isolates HOME/XDG/database paths, starts only its private server/TUI, and uses disconnected or synthetic account data with no model requests. Require rendered footer/dialog checks, RPC authentication, and zero process exit codes.

Reports stay in ignored `.artifacts/`; scratch directories use `$TMPDIR`. These tests do not establish real account access, native Windows/macOS, `mini`, or Node-distribution compatibility.
