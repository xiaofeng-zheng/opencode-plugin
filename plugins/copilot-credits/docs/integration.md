# Copilot credits build and host-probe guide

These are maintainer procedures, not user installation steps. Use the [plugin README](../README.md) for the user-level installer, the [reference](reference.md) for options and quota behavior, and the [verification history](verification.md) for previously recorded evidence.

## Build the distributable

Run from `plugins/copilot-credits/` in a source checkout or extracted source archive, **not** from the installed runtime package or the repository root. Use Node.js >=22.15 and npm with this plugin directory's lockfile; the root lockfile belongs to installer tooling.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

`build` stages a minimal package under `.artifacts/package/`. It retains TypeScript and precompiles TUI JSX using the Solid universal / OpenTUI preset, because the standard host's transform skips `node_modules`. The compiled implementation is `src/tui.js`, not raw `src/tui.tsx`.

`pack:check` runs `npm pack` **from the staged directory**, performs a clean-consumer installation, and uses the official Host resolver to check local-directory and npm resolution of server, TUI, and RPC entries. Distribute the resulting `.artifacts/opencode-copilot-credits-0.1.0.tgz`; do not run `npm pack` directly in the source root and treat it as the same package.

Solid/OpenTUI come from the host runtime rather than bundled copies. A separate Bun executable need not be on PATH, but runtime evidence applies only to the **standard Bun OpenCode CLI**, not a Node-distribution host. The source tree keeps the Solid version required by OpenTUI and pins its `seroval` dependency to `1.6.8`; it does not modify the OpenCode host's dependencies.

The package's source and minimal runtime serve different purposes. Tests, host probes, tarballs, build manifests, and logs stay outside the runtime tarball. Source-level checks and entry resolution do not, by themselves, prove rendered TUI behavior.

## Isolated no-inference host probes

These probes deliberately start their own private processes. Run them only when that test scope is authorized; they are not needed for normal user installation and must not restart a shared service.

```sh
python3 scripts/host-probe.py --binary /absolute/path/opencode --tui
python3 scripts/host-probe.py --binary /absolute/path/opencode --tui --session --synthetic-fixture
```

Use an absolute path to the **standard 2.1.2 CLI**. The harness uses a whitelisted environment, separate HOME/XDG/database paths, a fresh test password, and an explicit private endpoint. Tests use synthetic data, not a real Copilot account or real balance. They do not make model requests.

The disconnected case should show a disconnected RPC result and home footer/dialog rather than invented zero quota. The synthetic case exercises the prompt footer, `/copilot` details, quota arithmetic, and zero-reset date fallback. Check authenticated RPC separately from an unauthenticated request, which should receive HTTP 401. Record actual TUI/server exit statuses and whether any model request was attempted; expected outcomes are not completed verification until the probe reports them.

Logs and JSON reports go to ignored `.artifacts/`, and test sandboxes to ignored `.test-sandbox/`. Local runtime logs are not committed. A live account query requires separate authorization and separate evidence; never label synthetic fixture data as real quota.

## Compatibility limits

The historical host results cover Linux and the standard Bun CLI 2.1.2/full TUI. They do not establish native Windows/macOS support, Node-distribution OpenCode, `mini`, cross-version loading into a 2.0.32 shared server, Enterprise access, or universal real-account endpoint compatibility. Consult the [verification history](verification.md) before describing a result as tested.
