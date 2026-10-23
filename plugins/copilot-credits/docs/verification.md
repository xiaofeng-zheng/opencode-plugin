# Copilot credits verification history

This is a **historical record**, translated from the [verification document at commit 7090da0](https://github.com/xiaofeng-zheng/opencode-plugin/blob/7090da09ccbbde2b2210731f7975f0c7a4253826/plugins/copilot-credits/docs/verification.md). It reports checks performed when the standalone project was imported into `plugins/copilot-credits/`. It is not a new test run or verification of later code, packaging, or installer revisions. Local runtime logs were not committed.

The import record states that runtime code and tests were unchanged, with repository metadata, path documentation, and the plugin index added. The original directory was retained; `node_modules`, test sandboxes, databases, and local logs were not copied into the repository.

## Recorded source and package checks

- With Node.js **22.22.3**, `npm ci`, `npm run typecheck`, and `npm test` succeeded: **35 tests / 35 pass / 0 fail**.
- `npm run build` precompiled TUI JSX using the Solid universal / OpenTUI preset.
- `npm run pack:check` succeeded: packaging from `.artifacts/package/`, installing in a clean consumer, and resolving local-directory and npm server/TUI/RPC entries with the official Host.
- The runtime package's **17 files** matched the build manifest and actual installed contents byte for byte. It contained precompiled `src/tui.js`, not raw `src/tui.tsx`.

## Recorded standard OpenCode 2.1.2 Bun CLI checks

The historical probes used the real installed tarball, isolated HOME/XDG/database paths, a separate password, and an explicit private endpoint.

1. **Disconnected account:** actual RPC returned disconnected rather than a fabricated zero allowance; the home footer and `/copilot` details were visible.
2. **Synthetic quota fixture:** the session prompt footer, `/copilot` details, quota calculation, and zero-reset date fallback behaved correctly.
3. RPC requests without test authentication returned HTTP 401.
4. Neither scenario attempted or forwarded a model request; both TUI and private server exited with status 0.

Those probes did not query a real Copilot account or modify/restart an existing shared service. Synthetic data is not a user's actual balance.

## Reproducing checks

Follow the [build and host-probe guide](integration.md) from the plugin source directory. It preserves the build/package commands and disconnected/synthetic host-probe invocations. Rerunning host probes starts isolated test processes and needs appropriate authorization; the user-level installer does not activate OpenCode for you.

Use the standard 2.1.2 CLI for the historically documented host cases. Do not directly pack the source root: the distributable needs precompiled JSX. Reports belong in ignored `.artifacts/`, and test sandboxes in ignored `.test-sandbox/`.

## Not established by this record

Node-distribution OpenCode, `mini`, cross-version loading into a 2.0.32 shared server, Enterprise, native Windows/macOS runtimes, and universal real-account quota access remain outside the recorded evidence. Source/package checks also do not prove that a particular user's running server or TUI has loaded the plugin.
